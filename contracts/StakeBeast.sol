// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BeastNFT} from "./BeastNFT.sol";

/// @title StakeBeast
/// @notice Stake-to-commit escrow: stake ETH on a focus / habit session, get a
///         full refund plus a soulbound beast on verified success, or forfeit
///         the deposit along a preset route on failure.
/// @dev Implements the frozen contract design (contract-design v1.2, design
///      freeze 2026-10-19) over the frozen requirements baseline v1.4:
///      four modes (SoloFocus / Supervised / Duel / CoFocus), the unified time
///      model and settlement matrix, pull payments, and the EIP-712
///      CompletionAttestation for machine-proof modes.
contract StakeBeast is Ownable, ReentrancyGuard, EIP712 {
    // ------------------------------------------------------------------
    // Types (contract-design section 1)
    // ------------------------------------------------------------------

    enum Mode {
        SoloFocus,
        Supervised,
        Duel,
        CoFocus
    }
    enum Status {
        Pending,
        Active,
        Completed,
        Forfeited,
        Voided,
        Cancelled
    }
    enum Payee {
        Charity,
        Verifier,
        Custom
    } // preset admitDefeat route
    enum Kind {
        Focus,
        Habit
    } // NFT metadata kind
    enum Tier {
        Sprout,
        Juvenile,
        Adult,
        Golden
    }

    struct Session {
        Mode mode;
        Status status;
        address staker; // position owner
        address partner; // CoFocus: second participant; Duel: opponent; else 0
        address verifier; // human-proof verifier (Supervised / Duel position); else 0
        Payee payee; // admitDefeat route; CoFocus forced to Charity
        address customPayee; // when payee == Custom
        uint256 stake; // per position, wei; > 0
        uint32 durationMinutes; // focus modes (SoloFocus / CoFocus / Duel-focus tasks)
        uint16 periodDays; // Supervised habit period (1 = one-off task)
        uint8 checkInsPerDay; // advisory to verifier (default 1)
        uint16 targetCount; // advisory to verifier
        string criterion; // plain-text completion standard (advisory, for verifier)
        uint256 linkedSessionId; // Duel: the counter-position id; else 0
        uint64 createdAt;
        uint64 joinDeadline; // Duel / CoFocus; else 0
        uint64 startDeadline; // machine-proof modes; CoFocus: re-anchored at join
        uint64 startTime; // 0 until Active
        uint64 endTime; // startTime + duration / period
        uint64 settlementDeadline; // endTime + GRACE_DURATION
        bool joined; // Duel / CoFocus: partner funded
        bool startConfirmedStaker; // CoFocus start handshake
        bool startConfirmedPartner; // CoFocus start handshake
        bool minted; // one beast per position guard
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroStake();
    error StakeAboveCap(uint256 cap, uint256 actual);
    error DurationOutOfRange(uint32 durationMinutes);
    error PeriodOutOfRange(uint16 periodDays);
    error CheckInsPerDayOutOfRange(uint8 checkInsPerDay);
    error TargetCountOutOfRange(uint16 targetCount);
    error DuelTaskParamMismatch(); // Duel needs exactly one of duration / period
    error SelfCounterparty(address caller);
    error VerifierRequired(); // Supervised creation needs a non-zero verifier
    error PayeeVerifierNotAllowed(Mode mode); // Payee.Verifier is human-proof only
    error CustomPayeeZero();
    error CoFocusPayeeNotCharity(Payee payee);
    error ZeroCharity();
    error ZeroAttester();
    error UnknownSession(uint256 sessionId);
    error WrongStatus(uint256 sessionId, Status actual);
    error WrongMode(uint256 sessionId, Mode actual);
    error NotStaker(uint256 sessionId, address caller);
    error NotParticipant(uint256 sessionId, address caller);
    error NotVerifier(uint256 sessionId, address caller);
    error NotOpponent(uint256 sessionId, address caller);
    error SelfJoinNotAllowed(uint256 sessionId);
    error AlreadyJoined(uint256 sessionId);
    error NotJoinedYet(uint256 sessionId);
    error AlreadyConfirmed(uint256 sessionId, address participant);
    error StakeMismatch(uint256 expected, uint256 actual);
    error JoinDeadlinePassed(uint256 sessionId);
    error StartDeadlinePassed(uint256 sessionId);
    error JoinWindowOpen(uint256 sessionId); // cancelPending too early (join phase)
    error StartWindowOpen(uint256 sessionId); // cancelPending too early (start phase)
    error OutsideSettlementWindow(uint256 sessionId); // settle / verify / admitDefeat timing
    error NotYetForfeitable(uint256 sessionId); // forfeit before settlementDeadline
    error OutsideTaskWindow(uint256 sessionId); // checkIn outside [startTime, endTime)
    error InvalidAttestation(); // settle signature check failed
    error NothingToWithdraw(address account);
    error WithdrawTransferFailed(address account, uint256 amount);

    // ------------------------------------------------------------------
    // Events (contract-design section 3)
    // ------------------------------------------------------------------

    event SessionCreated(
        uint256 indexed id,
        Mode mode,
        address indexed staker,
        address counterparty,
        uint256 stake,
        uint64 joinDeadline,
        uint64 startDeadline
    );
    event SessionJoined(uint256 indexed id, address indexed participant, uint256 stake, uint256 linkedId);
    event StartConfirmed(uint256 indexed id, address indexed participant); // CoFocus handshake
    event SessionStarted(uint256 indexed id, uint64 startTime, uint64 endTime, uint64 settlementDeadline);
    event SessionCancelled(uint256 indexed id, uint8 reason); // 0=join timeout 1=start timeout
    event SessionCompleted(uint256 indexed id, address[] beneficiaries, uint256[] tokenIds);
    event SessionForfeited(uint256 indexed id, uint8 reason); // 0=admitDefeat 1=timeout 2=joint
    event SessionVoided(uint256 indexed id, address indexed by);
    event CheckedIn(uint256 indexed id, address indexed staker, bytes32 evidenceHash, uint16 periodIndex);
    event AttesterUpdated(address indexed oldAttester, address indexed newAttester);
    event Withdrawn(address indexed account, uint256 amount);

    // ------------------------------------------------------------------
    // Parameter ranges (contract-design section 1)
    // ------------------------------------------------------------------

    uint256 public constant MAX_STAKE = 100 ether;
    uint32 public constant MIN_DURATION_MINUTES = 1;
    uint32 public constant MAX_DURATION_MINUTES = 1440;
    uint16 public constant MIN_PERIOD_DAYS = 1;
    uint16 public constant MAX_PERIOD_DAYS = 365;
    uint8 public constant MIN_CHECKINS_PER_DAY = 1;
    uint8 public constant MAX_CHECKINS_PER_DAY = 8;
    uint16 public constant MIN_TARGET_COUNT = 1;
    uint16 public constant MAX_TARGET_COUNT = 1000;

    bytes32 private constant COMPLETION_TYPEHASH =
        keccak256(
            "CompletionAttestation(uint256 sessionId,address staker,address partner,uint64 startTime,uint64 endTime,uint64 expiry)"
        );

    // ------------------------------------------------------------------
    // State (contract-design section 1)
    // ------------------------------------------------------------------

    mapping(uint256 => Session) public sessions;
    uint256 public nextSessionId = 1; // 0 = "no link"
    mapping(address => uint256) public claimable; // pull-payment balances
    mapping(address => uint256[]) internal _sessionsOf;
    address public attester; // EIP-712 signer for machine-proof modes
    address public immutable charity; // forfeit sink; deployer-designated (see section 1 note)
    BeastNFT public immutable beastNFT;

    uint64 public immutable JOIN_WINDOW;
    uint64 public immutable START_WINDOW;
    uint64 public immutable GRACE_DURATION;

    constructor(
        address initialOwner,
        address initialAttester,
        address charityAddress,
        BeastNFT beastNFTAddress,
        uint64 joinWindow,
        uint64 startWindow,
        uint64 graceDuration
    ) Ownable(initialOwner) EIP712("StakeBeast", "1") {
        if (charityAddress == address(0)) revert ZeroCharity();
        charity = charityAddress;
        attester = initialAttester;
        beastNFT = beastNFTAddress;
        JOIN_WINDOW = joinWindow;
        START_WINDOW = startWindow;
        GRACE_DURATION = graceDuration;
    }

    modifier validSession(uint256 sessionId) {
        if (sessionId == 0 || sessionId >= nextSessionId) revert UnknownSession(sessionId);
        _;
    }

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    /// @notice Create a session and lock the stake.
    /// @param mode SoloFocus / Supervised / Duel / CoFocus.
    /// @param counterparty Supervised: verifier; Duel: opponent; SoloFocus / CoFocus: 0.
    /// @param payee Preset admitDefeat route (CoFocus must be Charity).
    /// @param customPayee Recipient when payee == Custom (must be non-zero).
    function createSession(
        Mode mode,
        address counterparty,
        Payee payee,
        address customPayee,
        uint32 durationMinutes,
        uint16 periodDays,
        uint8 checkInsPerDay,
        uint16 targetCount,
        string calldata criterion
    ) external payable nonReentrant returns (uint256 sessionId) {
        if (msg.value == 0) revert ZeroStake();
        if (msg.value > MAX_STAKE) revert StakeAboveCap(MAX_STAKE, msg.value);
        if (counterparty == msg.sender) revert SelfCounterparty(msg.sender);
        if (mode == Mode.Supervised && counterparty == address(0)) revert VerifierRequired();
        _validatePayeeCombination(mode, payee, customPayee);
        _validateTaskParams(mode, durationMinutes, periodDays, checkInsPerDay, targetCount);

        sessionId = nextSessionId++;
        _storeNewSession(
            sessionId,
            mode,
            counterparty,
            payee,
            customPayee,
            durationMinutes,
            periodDays,
            checkInsPerDay,
            targetCount,
            criterion
        );
        _sessionsOf[msg.sender].push(sessionId);

        Session storage s = sessions[sessionId];
        emit SessionCreated(
            sessionId, mode, msg.sender, counterparty, msg.value, s.joinDeadline, s.startDeadline
        );
        if (s.status == Status.Active) {
            // Human-proof modes enter Active immediately (startTime = creation).
            emit SessionStarted(sessionId, s.startTime, s.endTime, s.settlementDeadline);
        }
    }

    function _storeNewSession(
        uint256 sessionId,
        Mode mode,
        address counterparty,
        Payee payee,
        address customPayee,
        uint32 durationMinutes,
        uint16 periodDays,
        uint8 checkInsPerDay,
        uint16 targetCount,
        string calldata criterion
    ) internal {
        Session storage s = sessions[sessionId];
        s.mode = mode;
        s.status = Status.Pending;
        s.staker = msg.sender;
        s.payee = payee;
        if (payee == Payee.Custom) s.customPayee = customPayee;
        s.stake = msg.value;
        s.durationMinutes = durationMinutes;
        s.periodDays = periodDays;
        s.checkInsPerDay = checkInsPerDay;
        s.targetCount = targetCount;
        s.criterion = criterion;
        s.createdAt = uint64(block.timestamp);

        if (mode == Mode.Supervised) {
            s.verifier = counterparty;
            _activate(s, uint64(block.timestamp));
        } else if (mode == Mode.Duel) {
            s.partner = counterparty;
            s.verifier = counterparty; // A's position is verified by B
            s.joinDeadline = uint64(block.timestamp) + JOIN_WINDOW;
        } else if (mode == Mode.SoloFocus) {
            s.startDeadline = uint64(block.timestamp) + START_WINDOW;
        } else {
            // CoFocus: open join; startDeadline is re-anchored when the partner funds.
            s.joinDeadline = uint64(block.timestamp) + JOIN_WINDOW;
        }
    }

    /// @notice Fund the counter-position of a Duel / CoFocus session.
    /// @return id Duel: the created mirror position id; CoFocus: sessionId.
    function joinSession(uint256 sessionId, Payee payee, address customPayee)
        external
        payable
        nonReentrant
        validSession(sessionId)
        returns (uint256 id)
    {
        Session storage s = sessions[sessionId];
        Mode mode = s.mode;
        if (mode != Mode.Duel && mode != Mode.CoFocus) revert WrongMode(sessionId, mode);
        if (s.status != Status.Pending) revert WrongStatus(sessionId, s.status);
        if (s.joined) revert AlreadyJoined(sessionId);
        if (block.timestamp >= s.joinDeadline) revert JoinDeadlinePassed(sessionId);
        if (msg.value != s.stake) revert StakeMismatch(s.stake, msg.value);

        uint64 now_ = uint64(block.timestamp);
        if (mode == Mode.Duel) {
            if (msg.sender != s.partner) revert NotOpponent(sessionId, msg.sender);
            _validatePayeeCombination(Mode.Duel, payee, customPayee);

            id = _activateDuel(sessionId, s, msg.sender, payee, customPayee, now_);
            _sessionsOf[msg.sender].push(id);
            emit SessionJoined(sessionId, msg.sender, msg.value, id);
            emit SessionStarted(sessionId, s.startTime, s.endTime, s.settlementDeadline);
            Session storage b = sessions[id];
            emit SessionStarted(id, b.startTime, b.endTime, b.settlementDeadline);
        } else {
            // CoFocus: the creator may not join their own two-person session (R6).
            if (msg.sender == s.staker) revert SelfJoinNotAllowed(sessionId);
            if (payee != Payee.Charity) revert CoFocusPayeeNotCharity(payee);
            s.partner = msg.sender;
            s.joined = true;
            s.startDeadline = now_ + START_WINDOW; // re-anchored at join
            _sessionsOf[msg.sender].push(sessionId);
            emit SessionJoined(sessionId, msg.sender, msg.value, 0);
            id = sessionId;
        }
    }

    /// @dev Duel join: A's position activates and B's mirror position is
    ///      created Active on the same window; B's own forfeit route (F14) and
    ///      A's task parameters are recorded on the mirror.
    function _activateDuel(
        uint256 sessionId,
        Session storage s,
        address joiner,
        Payee payee,
        address customPayee,
        uint64 now_
    ) internal returns (uint256 id) {
        id = nextSessionId++;
        s.joined = true;
        s.linkedSessionId = id;
        _activate(s, now_);

        Session storage b = sessions[id];
        b.mode = Mode.Duel;
        b.status = Status.Active;
        b.staker = joiner;
        b.partner = s.staker;
        b.verifier = s.staker; // B's position is verified by A
        b.payee = payee; // B's own forfeit route (F14)
        if (payee == Payee.Custom) b.customPayee = customPayee;
        b.stake = s.stake;
        b.durationMinutes = s.durationMinutes; // task parameters copied from A
        b.periodDays = s.periodDays;
        b.checkInsPerDay = s.checkInsPerDay;
        b.targetCount = s.targetCount;
        b.criterion = s.criterion;
        b.linkedSessionId = sessionId;
        b.createdAt = now_;
        b.joined = true;
        _activate(b, now_);
    }

    /// @notice Explicit on-chain start for machine-proof modes (ready-first, F11).
    function startSession(uint256 sessionId) external validSession(sessionId) {
        Session storage s = sessions[sessionId];
        Mode mode = s.mode;
        if (mode != Mode.SoloFocus && mode != Mode.CoFocus) revert WrongMode(sessionId, mode);
        if (s.status != Status.Pending) revert WrongStatus(sessionId, s.status);

        uint64 now_ = uint64(block.timestamp);
        if (mode == Mode.SoloFocus) {
            if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
            if (block.timestamp >= s.startDeadline) revert StartDeadlinePassed(sessionId);
            _activate(s, now_);
            emit SessionStarted(sessionId, s.startTime, s.endTime, s.settlementDeadline);
        } else {
            // CoFocus start handshake (F1): both parties funded, each confirms once;
            // the second confirmation anchors startTime. The joined gate comes
            // first: an unjoined session (startDeadline still 0) always reverts
            // here rather than on the unset deadline.
            if (!s.joined) revert NotJoinedYet(sessionId);
            if (block.timestamp >= s.startDeadline) revert StartDeadlinePassed(sessionId);
            if (msg.sender == s.staker) {
                if (s.startConfirmedStaker) revert AlreadyConfirmed(sessionId, msg.sender);
                s.startConfirmedStaker = true;
            } else if (msg.sender == s.partner) {
                if (s.startConfirmedPartner) revert AlreadyConfirmed(sessionId, msg.sender);
                s.startConfirmedPartner = true;
            } else {
                revert NotParticipant(sessionId, msg.sender);
            }
            emit StartConfirmed(sessionId, msg.sender);
            if (s.startConfirmedStaker && s.startConfirmedPartner) {
                _activate(s, now_);
                emit SessionStarted(sessionId, s.startTime, s.endTime, s.settlementDeadline);
            }
        }
    }

    /// @notice Cancel a Pending session whose phase-matched deadline has passed
    ///         (R6: join phase judges joinDeadline, start phase judges startDeadline).
    function cancelPending(uint256 sessionId) external nonReentrant validSession(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.status != Status.Pending) revert WrongStatus(sessionId, s.status);
        Mode mode = s.mode;
        uint8 reason; // 0=join timeout 1=start timeout
        if (mode == Mode.SoloFocus) {
            if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
            if (block.timestamp < s.startDeadline) revert StartWindowOpen(sessionId);
            reason = 1;
            claimable[s.staker] += s.stake;
        } else if (mode == Mode.Duel) {
            // A Pending duel is by definition unjoined; only its own joinDeadline counts.
            if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
            if (block.timestamp < s.joinDeadline) revert JoinWindowOpen(sessionId);
            reason = 0;
            claimable[s.staker] += s.stake;
        } else if (mode == Mode.CoFocus) {
            if (!s.joined) {
                if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
                if (block.timestamp < s.joinDeadline) revert JoinWindowOpen(sessionId);
                reason = 0;
                claimable[s.staker] += s.stake;
            } else {
                if (msg.sender != s.staker && msg.sender != s.partner) {
                    revert NotParticipant(sessionId, msg.sender);
                }
                if (block.timestamp < s.startDeadline) revert StartWindowOpen(sessionId);
                reason = 1;
                claimable[s.staker] += s.stake;
                claimable[s.partner] += s.stake;
            }
        } else {
            revert WrongMode(sessionId, mode); // Supervised is never Pending
        }
        s.status = Status.Cancelled;
        emit SessionCancelled(sessionId, reason);
    }

    // ------------------------------------------------------------------
    // Settlement matrix
    // ------------------------------------------------------------------

    /// @notice Settle a machine-proof session with a valid attester attestation.
    function settle(uint256 sessionId, bytes calldata signature)
        external
        nonReentrant
        validSession(sessionId)
    {
        Session storage s = sessions[sessionId];
        Mode mode = s.mode;
        if (mode != Mode.SoloFocus && mode != Mode.CoFocus) revert WrongMode(sessionId, mode);
        if (msg.sender != s.staker && msg.sender != s.partner) {
            revert NotParticipant(sessionId, msg.sender);
        }
        if (s.status != Status.Active) revert WrongStatus(sessionId, s.status);
        if (block.timestamp < s.endTime || block.timestamp >= s.settlementDeadline) {
            revert OutsideSettlementWindow(sessionId);
        }

        // The digest is rebuilt from stored session fields only — the contract
        // never trusts client-supplied fields (contract-design section 4, R9).
        bytes32 structHash = keccak256(
            abi.encode(
                COMPLETION_TYPEHASH,
                sessionId,
                s.staker,
                s.partner,
                s.startTime,
                s.endTime,
                s.settlementDeadline // expiry
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer == address(0) || signer != attester) revert InvalidAttestation();

        s.status = Status.Completed;
        s.minted = true;

        uint256 count = mode == Mode.CoFocus ? 2 : 1;
        address[] memory beneficiaries = new address[](count);
        uint256[] memory tokenIds = new uint256[](count);
        beneficiaries[0] = s.staker;
        claimable[s.staker] += s.stake;
        tokenIds[0] = _mintBeast(sessionId, s, s.staker);
        if (count == 2) {
            beneficiaries[1] = s.partner;
            claimable[s.partner] += s.stake;
            tokenIds[1] = _mintBeast(sessionId, s, s.partner);
        }
        emit SessionCompleted(sessionId, beneficiaries, tokenIds);
    }

    /// @notice Verifier confirms completion of a human-proof position. Checks
    ///         only the target position's state (R9): the verifier's own linked
    ///         position may be in any state.
    function verify(uint256 sessionId) external nonReentrant validSession(sessionId) {
        Session storage s = sessions[sessionId];
        Mode mode = s.mode;
        if (mode != Mode.Supervised && mode != Mode.Duel) revert WrongMode(sessionId, mode);
        if (msg.sender != s.verifier) revert NotVerifier(sessionId, msg.sender);
        if (s.status != Status.Active) revert WrongStatus(sessionId, s.status);
        if (block.timestamp >= s.settlementDeadline) revert OutsideSettlementWindow(sessionId);

        s.status = Status.Completed;
        s.minted = true;
        claimable[s.staker] += s.stake;

        address[] memory beneficiaries = new address[](1);
        uint256[] memory tokenIds = new uint256[](1);
        beneficiaries[0] = s.staker;
        tokenIds[0] = _mintBeast(sessionId, s, s.staker);
        emit SessionCompleted(sessionId, beneficiaries, tokenIds);
    }

    /// @notice Staker (either participant in CoFocus) concedes before the
    ///         deadline: confession pays the preset route; CoFocus joint
    ///         liability routes both stakes to charity.
    function admitDefeat(uint256 sessionId) external nonReentrant validSession(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.status != Status.Active) revert WrongStatus(sessionId, s.status);
        if (block.timestamp >= s.settlementDeadline) revert OutsideSettlementWindow(sessionId);
        s.status = Status.Forfeited;

        if (s.mode == Mode.CoFocus) {
            if (msg.sender != s.staker && msg.sender != s.partner) {
                revert NotParticipant(sessionId, msg.sender);
            }
            claimable[charity] += 2 * s.stake;
            emit SessionForfeited(sessionId, 2); // joint
        } else {
            if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
            address receiver = s.payee == Payee.Charity
                ? charity
                : s.payee == Payee.Verifier
                    ? s.verifier
                    : s.customPayee;
            claimable[receiver] += s.stake;
            emit SessionForfeited(sessionId, 0); // admitDefeat
        }
    }

    /// @notice Permissionless forfeit of an Active session at/after its
    ///         settlementDeadline: stake(s) to charity.
    function forfeit(uint256 sessionId) external nonReentrant validSession(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.status != Status.Active) revert WrongStatus(sessionId, s.status);
        if (block.timestamp < s.settlementDeadline) revert NotYetForfeitable(sessionId);
        s.status = Status.Forfeited;

        claimable[charity] += (s.mode == Mode.CoFocus ? 2 : 1) * s.stake;
        emit SessionForfeited(sessionId, 1); // timeout
    }

    /// @notice Admin void of a non-terminal session (platform fault): full
    ///         principal refund, no mint, no forfeit routing.
    function voidSession(uint256 sessionId) external nonReentrant onlyOwner validSession(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.status != Status.Pending && s.status != Status.Active) {
            revert WrongStatus(sessionId, s.status);
        }
        s.status = Status.Voided;

        claimable[s.staker] += s.stake;
        if (s.mode == Mode.CoFocus && s.joined) claimable[s.partner] += s.stake;
        emit SessionVoided(sessionId, msg.sender);
    }

    /// @notice Anchor a check-in evidence hash (P1). The contract stores
    ///         nothing about the photo and never counts check-ins against
    ///         targetCount — the verifier's `verify` is the sole completion
    ///         basis (v1.4 D4, F10).
    function checkIn(uint256 sessionId, bytes32 evidenceHash) external validSession(sessionId) {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.staker) revert NotStaker(sessionId, msg.sender);
        if (s.status != Status.Active) revert WrongStatus(sessionId, s.status);
        if (block.timestamp < s.startTime || block.timestamp >= s.endTime) {
            revert OutsideTaskWindow(sessionId);
        }
        uint16 periodIndex = uint16((block.timestamp - s.startTime) / 1 days);
        emit CheckedIn(sessionId, msg.sender, evidenceHash, periodIndex);
    }

    // ------------------------------------------------------------------
    // Funds
    // ------------------------------------------------------------------

    /// @notice Sweep the caller's claimable balance (pull payment, retryable).
    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw(msg.sender);
        claimable[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawTransferFailed(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Rotate the attester signer (R2): takes effect immediately for
    ///         all future `settle` calls; old-key signatures fail from then on.
    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAttester();
        emit AttesterUpdated(attester, newAttester);
        attester = newAttester;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getSession(uint256 sessionId) external view validSession(sessionId) returns (Session memory) {
        return sessions[sessionId];
    }

    function sessionsOf(address account) external view returns (uint256[] memory) {
        return _sessionsOf[account];
    }

    function claimableOf(address account) external view returns (uint256) {
        return claimable[account];
    }

    /// @notice Dual-track tier ladder (contract-design section 7): rounding
    ///         down against declared values, never actual elapsed time.
    function tierFor(Kind kind, uint256 metricValue) external pure returns (Tier) {
        if (kind == Kind.Focus) {
            if (metricValue >= 120) return Tier.Golden;
            if (metricValue >= 50) return Tier.Adult;
            if (metricValue >= 25) return Tier.Juvenile;
            return Tier.Sprout;
        }
        if (metricValue >= 21) return Tier.Golden;
        if (metricValue >= 7) return Tier.Adult;
        if (metricValue >= 3) return Tier.Juvenile;
        return Tier.Sprout;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _activate(Session storage s, uint64 now_) internal {
        s.status = Status.Active;
        s.startTime = now_;
        s.endTime = now_ + _windowSeconds(s);
        s.settlementDeadline = s.endTime + GRACE_DURATION;
    }

    function _windowSeconds(Session storage s) internal view returns (uint64) {
        if (s.durationMinutes > 0) return uint64(s.durationMinutes) * 60;
        return uint64(s.periodDays) * 1 days;
    }

    function _mintBeast(uint256 sessionId, Session storage s, address to) internal returns (uint256) {
        if (s.durationMinutes > 0) {
            return beastNFT.mint(to, sessionId, BeastNFT.Kind.Focus, s.durationMinutes);
        }
        return beastNFT.mint(to, sessionId, BeastNFT.Kind.Habit, s.periodDays);
    }

    function _validatePayeeCombination(Mode mode, Payee payee, address customPayee) internal pure {
        if (payee == Payee.Verifier) {
            // Only modes with a real verifier may route confessions to it
            // (R6); otherwise forfeits would credit the zero address.
            if (mode != Mode.Supervised && mode != Mode.Duel) {
                revert PayeeVerifierNotAllowed(mode);
            }
        } else if (payee == Payee.Custom) {
            if (customPayee == address(0)) revert CustomPayeeZero();
        }
        // CoFocus joint liability routes both stakes to charity (R6).
        if (mode == Mode.CoFocus && payee != Payee.Charity) {
            revert CoFocusPayeeNotCharity(payee);
        }
    }

    function _validateTaskParams(
        Mode mode,
        uint32 durationMinutes,
        uint16 periodDays,
        uint8 checkInsPerDay,
        uint16 targetCount
    ) internal pure {
        if (mode == Mode.SoloFocus || mode == Mode.CoFocus) {
            if (durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
                revert DurationOutOfRange(durationMinutes);
            }
        } else if (mode == Mode.Supervised) {
            _validateHabitParams(periodDays, checkInsPerDay, targetCount);
        } else {
            // Duel: exactly one task style (focus by duration xor habit by period).
            bool hasDuration = durationMinutes > 0;
            bool hasPeriod = periodDays > 0;
            if (hasDuration == hasPeriod) revert DuelTaskParamMismatch();
            if (hasDuration) {
                if (durationMinutes > MAX_DURATION_MINUTES) revert DurationOutOfRange(durationMinutes);
            } else {
                _validateHabitParams(periodDays, checkInsPerDay, targetCount);
            }
        }
    }

    function _validateHabitParams(uint16 periodDays, uint8 checkInsPerDay, uint16 targetCount)
        internal
        pure
    {
        if (periodDays < MIN_PERIOD_DAYS || periodDays > MAX_PERIOD_DAYS) {
            revert PeriodOutOfRange(periodDays);
        }
        if (checkInsPerDay < MIN_CHECKINS_PER_DAY || checkInsPerDay > MAX_CHECKINS_PER_DAY) {
            revert CheckInsPerDayOutOfRange(checkInsPerDay);
        }
        if (targetCount < MIN_TARGET_COUNT || targetCount > MAX_TARGET_COUNT) {
            revert TargetCountOutOfRange(targetCount);
        }
    }
}
