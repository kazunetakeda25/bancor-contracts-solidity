// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

/*
    Contract Registry interface
*/
abstract contract IContractRegistry {
    function addressOf(bytes32 _contractName) public virtual view returns (address);
}
