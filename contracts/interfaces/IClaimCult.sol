// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.4;

interface IClaimCult {
    function claimed(address a) external view returns (bool);

    function claim(
        address _destination,
        uint256 _amount,
        bytes32[] memory _proof,
        string calldata
    ) external payable;
}
