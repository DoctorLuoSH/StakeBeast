// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title BeastNFT
/// @notice Soulbound (non-transferable) ERC721 minted by the StakeBeast main
///         contract when a stake position completes successfully.
/// @dev Implements the frozen requirements baseline v1.4 section 4.8 / D8:
///      dual-track tiers (focus by declared minutes, habit by cycle days) and
///      at most one beast per stake position per session.
contract BeastNFT is ERC721, Ownable {
    using Strings for uint256;

    enum BeastType {
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
        BeastType beastType;
        Tier tier;
        uint256 measuredValue; // declared minutes (focus) or cycle days (habit)
        uint256 completedAt; // completion date (unix timestamp)
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
        BeastType beastType,
        uint256 measuredValue,
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
    /// @param to Staker receiving the beast (identifies the stake position).
    /// @param sessionId Session the stake position belongs to.
    /// @param beastType Focus or habit.
    /// @param measuredValue Declared minutes (focus) or cycle days (habit).
    function mint(address to, uint256 sessionId, BeastType beastType, uint256 measuredValue)
        external
        returns (uint256 tokenId)
    {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        if (mintedBySession[sessionId][to]) revert AlreadyMinted(sessionId, to);
        mintedBySession[sessionId][to] = true;

        tokenId = ++_nextTokenId;
        Tier tier = tierOf(beastType, measuredValue);
        _meta[tokenId] = BeastMeta({
            beastType: beastType,
            tier: tier,
            measuredValue: measuredValue,
            completedAt: block.timestamp,
            sessionId: sessionId
        });
        _safeMint(to, tokenId);
        emit BeastMinted(tokenId, to, sessionId, beastType, measuredValue, tier);
    }

    /// @notice Dual-track tier ladder (baseline v1.4 section 4.8):
    ///         focus >=120/50/25 min -> golden/adult/juvenile, else sprout;
    ///         habit >=21/7/3 days -> golden/adult/juvenile, else sprout.
    function tierOf(BeastType beastType, uint256 measuredValue) public pure returns (Tier) {
        if (beastType == BeastType.Focus) {
            if (measuredValue >= 120) return Tier.Golden;
            if (measuredValue >= 50) return Tier.Adult;
            if (measuredValue >= 25) return Tier.Juvenile;
            return Tier.Sprout;
        }
        if (measuredValue >= 21) return Tier.Golden;
        if (measuredValue >= 7) return Tier.Adult;
        if (measuredValue >= 3) return Tier.Juvenile;
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

    /// @dev Minting (from == 0) stays allowed; any transfer between two
    ///      addresses reverts, which covers transferFrom / safeTransferFrom.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && to != address(0)) revert Soulbound();
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
            m.beastType == BeastType.Focus ? "focus" : "habit",
            '"},',
            '{"trait_type":"Tier","value":"',
            _tierName(m.tier),
            '"},',
            '{"trait_type":"Measured Value","value":',
            m.measuredValue.toString(),
            "},",
            '{"trait_type":"Completed At","value":',
            m.completedAt.toString(),
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
