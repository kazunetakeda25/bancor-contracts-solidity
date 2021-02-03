// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "../utility/Owned.sol";

interface ISettings {
    function poolWhitelist() external view returns (address[] memory);
    function addPoolToWhitelist(address pool) external;
    function networkTokenMintingLimits(address pool) external view returns (uint256);
    function setNetworkTokenMintingLimit(address pool, uint256 limit) external;
    function renounceRole(bytes32 role, address account) external;
}

contract LiquidityProtectionSettingsMigrator is Owned {
    function migrate(ISettings sourceSettings, ISettings targetSettings) external ownerOnly {
        address[] memory poolWhitelist = sourceSettings.poolWhitelist();
        for (uint256 i = 0; i < poolWhitelist.length; i++) {
            address pool = address(poolWhitelist[i]);
            targetSettings.addPoolToWhitelist(pool);
            targetSettings.setNetworkTokenMintingLimit(pool, sourceSettings.networkTokenMintingLimits(pool));
        }
        targetSettings.renounceRole(keccak256("ROLE_OWNER"), address(this));
        selfdestruct(payable(owner));
    }
}
