// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "./INetworkSettings.sol";
import "./utility/Owned.sol";
import "./utility/Utils.sol";

/**
 * @dev This contract maintains the network settings.
 */
contract NetworkSettings is INetworkSettings, Owned, Utils {
    address private _networkFeeWallet;
    uint32 private _networkFee;

    /**
     * @dev initializes a new NetworkSettings contract
     */
    constructor(address networkFeeWallet, uint32 networkFee) validAddress(networkFeeWallet) validPortion(networkFee) public {
        _networkFeeWallet = networkFeeWallet;
        _networkFee = networkFee;
    }

    /**
     * @dev returns the network settings
     *
     * @return network fee wallet
     * @return network fee in ppm units
     */
    function feeParams() external view override returns (address, uint32) {
        return (_networkFeeWallet, _networkFee);
    }

    /**
     * @dev sets the network fee wallet
     * can be executed only by the owner
     *
     * @param networkFeeWallet network fee wallet
     */
    function setNetworkFeeWallet(address networkFeeWallet) external ownerOnly validAddress(networkFeeWallet) {
        _networkFeeWallet = networkFeeWallet;
    }

    /**
     * @dev sets the network fee
     * can be executed only by the owner
     *
     * @param networkFee network fee in ppm units
     */
    function setNetworkFee(uint32 networkFee) external ownerOnly validPortion(networkFee) {
        _networkFee = networkFee;
    }
}
