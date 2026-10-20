/**
 * Minimal human-readable ABI of the frozen StakeBeast contract — exactly the
 * surface the backend reads: getSession plus the SessionCreated / CheckedIn
 * events. Shared by the production gateway and the test fake so both encode
 * and decode the same wire format.
 */

import { id } from 'ethers';

export const STAKEBEAST_ABI = [
  'function getSession(uint256 sessionId) view returns (tuple(uint8 mode, uint8 status, address staker, address partner, address verifier, uint8 payee, address customPayee, uint256 stake, uint32 durationMinutes, uint16 periodDays, uint8 checkInsPerDay, uint16 targetCount, string criterion, uint256 linkedSessionId, uint64 createdAt, uint64 joinDeadline, uint64 startDeadline, uint64 startTime, uint64 endTime, uint64 settlementDeadline, bool joined, bool startConfirmedStaker, bool startConfirmedPartner, bool minted))',
  'event SessionCreated(uint256 indexed id, uint8 mode, address indexed staker, address counterparty, uint256 stake, uint64 joinDeadline, uint64 startDeadline)',
  'event CheckedIn(uint256 indexed id, address indexed staker, bytes32 evidenceHash, uint16 periodIndex)',
];

/** keccak256 of the CheckedIn signature — topic[0] of a matching log. */
export const CHECKED_IN_TOPIC = id('CheckedIn(uint256,address,bytes32,uint16)');
