// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title BeastNFT
/// @notice Soulbound (non-transferable) ERC721 minted by the StakeBeast main
///         contract when a stake position completes successfully.
/// @dev Implements the frozen requirements baseline v1.4 section 4.8 / D8 and
///      the frozen contract design (contract-design v1.2): dual-track tiers
///      (focus by declared minutes, habit by cycle days), at most one beast per
///      stake position per session, fully on-chain metadata (F8), and minting
///      via OZ `_mint` (never `_safeMint`) so no receiver hook can block a
///      settlement (contract-design section 6, R9).
contract BeastNFT is ERC721, Ownable {
    using Strings for uint256;

    enum Kind {
        Focus,
        Habit
    }

    enum Tier {
        Sprout,
        Juvenile,
        Adult,
        Golden
    }

    struct BeastMeta {
        Kind kind;
        uint256 metricValue; // declared minutes (focus) or cycle days (habit)
        Tier tier;
        uint64 completionDate; // completion date (unix timestamp)
        uint256 sessionId;
    }

    /// @notice Sole address allowed to mint; the StakeBeast main contract is
    ///         plugged in here once deployed.
    address public minter;

    uint256 private _nextTokenId; // token IDs start at 1

    mapping(uint256 => BeastMeta) private _meta;

    /// @notice sessionId => staker => already minted (one beast per stake
    ///         position per session).
    mapping(uint256 => mapping(address => bool)) public mintedBySession;

    event BeastMinted(
        uint256 indexed tokenId,
        address indexed to,
        uint256 indexed sessionId,
        Kind kind,
        uint256 metricValue,
        Tier tier
    );
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);

    error NotMinter(address caller);
    error AlreadyMinted(uint256 sessionId, address staker);
    error Soulbound();

    constructor(address initialOwner, address initialMinter)
        ERC721("StakeBeast", "BEAST")
        Ownable(initialOwner)
    {
        minter = initialMinter;
    }

    /// @notice Point the mint permission at a new address (e.g. the StakeBeast
    ///         main contract once it is deployed).
    function setMinter(address newMinter) external onlyOwner {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    /// @notice Mint the success beast for one stake position of a session.
    /// @dev Uses OZ `_mint` on purpose (contract-design section 6, R9): no
    ///      `onERC721Received` callback is invoked, so a beneficiary contract
    ///      can never revert-or-block the settlement that triggers the mint.
    /// @param to Staker receiving the beast (identifies the stake position).
    /// @param sessionId Session the stake position belongs to.
    /// @param kind Focus or habit.
    /// @param metricValue Declared minutes (focus) or cycle days (habit).
    function mint(address to, uint256 sessionId, Kind kind, uint256 metricValue)
        external
        returns (uint256 tokenId)
    {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        if (mintedBySession[sessionId][to]) revert AlreadyMinted(sessionId, to);
        mintedBySession[sessionId][to] = true;

        tokenId = ++_nextTokenId;
        Tier tier = tierOf(kind, metricValue);
        _meta[tokenId] = BeastMeta({
            kind: kind,
            metricValue: metricValue,
            tier: tier,
            completionDate: uint64(block.timestamp),
            sessionId: sessionId
        });
        _mint(to, tokenId);
        emit BeastMinted(tokenId, to, sessionId, kind, metricValue, tier);
    }

    /// @notice Dual-track tier ladder (baseline v1.4 section 4.8):
    ///         focus >=120/50/25 min -> golden/adult/juvenile, else sprout;
    ///         habit >=21/7/3 days -> golden/adult/juvenile, else sprout.
    function tierOf(Kind kind, uint256 metricValue) public pure returns (Tier) {
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

    /// @notice On-chain metadata of a minted beast.
    function beastMeta(uint256 tokenId) external view returns (BeastMeta memory) {
        _requireOwned(tokenId);
        return _meta[tokenId];
    }

    // ---- Soulbound: every approval / transfer path reverts ----

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    /// @dev Minting (from == 0) stays allowed; any move of an already-owned
    ///      token reverts (contract-design section 6: revert on any transfer
    ///      where `from != address(0)`), covering transferFrom /
    ///      safeTransferFrom and burns alike.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @notice Fully on-chain ERC721 metadata (base64 JSON).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        BeastMeta memory m = _meta[tokenId];
        string memory json = string.concat(
            '{"name":"StakeBeast #',
            tokenId.toString(),
            '","description":"Soulbound beast minted for a completed StakeBeast stake position.",',
            '"attributes":[',
            '{"trait_type":"Beast Type","value":"',
            m.kind == Kind.Focus ? "focus" : "habit",
            '"},',
            '{"trait_type":"Tier","value":"',
            _tierName(m.tier),
            '"},',
            '{"trait_type":"Measured Value","value":',
            m.metricValue.toString(),
            "},",
            '{"trait_type":"Completed At","value":',
            uint256(m.completionDate).toString(),
            "},",
            '{"trait_type":"Session ID","value":',
            m.sessionId.toString(),
            "}]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _tierName(Tier tier) internal pure returns (string memory) {
        if (tier == Tier.Golden) return "golden";
        if (tier == Tier.Adult) return "adult";
        if (tier == Tier.Juvenile) return "juvenile";
        return "sprout";
    }
}
