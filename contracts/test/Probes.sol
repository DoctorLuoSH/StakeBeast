// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice TEST-ONLY probe: a contract staker that reverts on any ERC721
///         receiver hook. Used to prove the R9 mint-path property — settlement
///         succeeds even when the beneficiary could never receive via
///         `_safeMint` (minting uses `_mint`, no callback is ever invoked).
contract HookRevertingReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("hook not accepted");
    }

    /// @dev Generic driver so tests can act as this contract (createSession /
    ///      startSession / settle / withdraw ...).
    function drive(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory out) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(out, 32), mload(out))
            }
        }
        return out;
    }
}

/// @notice TEST-ONLY probe: a claimable-balance recipient that can fail its
///         receive hook or attempt a reentrant `withdraw`.
contract WithdrawProbe {
    address public stakeBeast;
    bool public failReceive;
    bool public reenterOnce;

    constructor(address stakeBeast_) {
        stakeBeast = stakeBeast_;
    }

    function setFailReceive(bool v) external {
        failReceive = v;
    }

    function setReenterOnce(bool v) external {
        reenterOnce = v;
    }

    function withdraw() external {
        (bool ok, bytes memory out) = stakeBeast.call(abi.encodeWithSignature("withdraw()"));
        if (!ok) {
            assembly {
                revert(add(out, 32), mload(out))
            }
        }
    }

    receive() external payable {
        if (reenterOnce) {
            reenterOnce = false;
            // Reentrancy must be blocked by the guard; a success here would be
            // a finding, so fail the whole probe transaction loudly instead of
            // silently swallowing the inner call's result.
            (bool ok,) = stakeBeast.call(abi.encodeWithSignature("withdraw()"));
            if (ok) revert("reentrant withdraw unexpectedly succeeded");
        }
        if (failReceive) revert("receive rejected");
    }
}
