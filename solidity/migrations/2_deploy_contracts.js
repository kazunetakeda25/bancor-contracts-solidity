/* global artifacts */
/* eslint-disable prefer-reflect */

const Utils = artifacts.require('Utils.sol');
const Owned = artifacts.require('Owned.sol');
const Managed = artifacts.require('Managed.sol');
const TokenHolder = artifacts.require('TokenHolder.sol');
const ERC20Token = artifacts.require('ERC20Token.sol');
const EtherToken = artifacts.require('EtherToken.sol');
const ContractFeatures = artifacts.require('ContractFeatures.sol');
const Whitelist = artifacts.require('Whitelist.sol');
const SmartToken = artifacts.require('SmartToken.sol');
const SmartTokenController = artifacts.require('SmartTokenController.sol');
const BancorFormula = artifacts.require('BancorFormula.sol');
const BancorGasPriceLimit = artifacts.require('BancorGasPriceLimit.sol');
const BancorQuickConverter = artifacts.require('BancorQuickConverter.sol');
const BancorConverterExtensions = artifacts.require('BancorConverterExtensions.sol');
const BancorConverter = artifacts.require('BancorConverter.sol');
const BancorConverterFactory = artifacts.require('BancorConverterFactory.sol');
const BancorConverterUpgrader = artifacts.require('BancorConverterUpgrader.sol');
const CrowdsaleController = artifacts.require('CrowdsaleController.sol');

module.exports = async deployer => {
    deployer.deploy(Utils);
    deployer.deploy(Owned);
    deployer.deploy(Managed);
    deployer.deploy(TokenHolder);
    deployer.deploy(ERC20Token, 'DummyToken', 'DUM', 0);
    deployer.deploy(EtherToken);
    deployer.deploy(ContractFeatures);
    deployer.deploy(Whitelist);
    await deployer.deploy(SmartToken, 'Token1', 'TKN1', 2);
    deployer.deploy(SmartTokenController, SmartToken.address);
    deployer.deploy(BancorFormula);
    deployer.deploy(BancorGasPriceLimit, '22000000000');
    deployer.deploy(BancorQuickConverter, '0x827182');
    deployer.deploy(BancorConverterExtensions, '0x125463', '0x145463', '0x125763');
    deployer.deploy(BancorConverter, SmartToken.address, '0x0', '0x124', 0, '0x0', 0);

    await deployer.deploy(BancorConverterFactory);
    await deployer.deploy(BancorConverterUpgrader, BancorConverterFactory.address, ContractFeatures.address);

    deployer.deploy(CrowdsaleController, SmartToken.address, 4102444800, '0x125', '0x126', 1);
};
