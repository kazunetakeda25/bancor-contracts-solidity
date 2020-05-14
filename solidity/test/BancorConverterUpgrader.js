/* global artifacts, contract, before, it, assert */
/* eslint-disable prefer-reflect */

const utils = require('./helpers/Utils');
const BancorConverter = require('./helpers/BancorConverter');
const ContractRegistryClient = require('./helpers/ContractRegistryClient');

const SmartToken = artifacts.require('SmartToken');
const EtherToken = artifacts.require('EtherToken');
const ERC20Token = artifacts.require('ERC20Token');
const ContractRegistry = artifacts.require('ContractRegistry');
const BancorConverterFactory = artifacts.require('BancorConverterFactory');
const BancorConverterUpgrader = artifacts.require('BancorConverterUpgrader');

const ETH_RESERVE_ADDRESS = '0x'.padEnd(42, 'e');

const CONVERSION_FEE     = '1000';
const MAX_CONVERSION_FEE = '30000';
const CONNECTOR1_BALANCE = '5000';
const CONNECTOR2_BALANCE = '8000';
const TOKEN_TOTAL_SUPPLY = '20000';

const versions = [9, 10, 11, 23];

let contractRegistry;
let converterFactory;

async function initWithConnectors(deployer, version, active) {
    const smartToken = await SmartToken.new('Smart Token', 'TKN1', 0);
    const connectorToken1 = await ERC20Token.new('ERC Token 1', 'ERC1', 0, CONNECTOR1_BALANCE);
    const connectorToken2 = await ERC20Token.new('ERC Token 2', 'ERC2', 0, CONNECTOR2_BALANCE);
    const converter = await BancorConverter.new(smartToken.address, contractRegistry.address, MAX_CONVERSION_FEE, connectorToken1.address, 500000, version);
    const upgrader = await BancorConverterUpgrader.new(contractRegistry.address, utils.zeroAddress);

    await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_UPGRADER, upgrader.address);
    await converter.addReserve(connectorToken2.address, 500000, false);
    await converter.setConversionFee(CONVERSION_FEE);
    await smartToken.issue(deployer, TOKEN_TOTAL_SUPPLY);
    await connectorToken1.transfer(converter.address, CONNECTOR1_BALANCE);
    await connectorToken2.transfer(converter.address, CONNECTOR2_BALANCE);

    if (active) {
        await smartToken.transferOwnership(converter.address);
        await converter.acceptTokenOwnership();
    }

    return [upgrader, converter];
}

async function initWithoutConnectors(deployer, version, active) {
    const smartToken = await SmartToken.new('Smart Token', 'TKN1', 0);
    const converter = await BancorConverter.new(smartToken.address, contractRegistry.address, 0, utils.zeroAddress, 0, version);
    const upgrader = await BancorConverterUpgrader.new(contractRegistry.address, utils.zeroAddress);

    await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_UPGRADER, upgrader.address);

    if (active) {
        throw new Error("converter with no reserves cannot be active");
    }

    return [upgrader, converter];
}

async function initWithEtherConnector(deployer, version, active) {
    const smartToken = await SmartToken.new('Smart Token', 'TKN1', 0);
    const connectorToken1 = await EtherToken.new('Ether Token', 'ETH');
    const connectorToken2 = await ERC20Token.new('ERC Token 2', 'ERC2', 0, CONNECTOR2_BALANCE);
    const converter = await BancorConverter.new(smartToken.address, contractRegistry.address, MAX_CONVERSION_FEE, connectorToken1.address, 500000, version);
    const upgrader = await BancorConverterUpgrader.new(contractRegistry.address, connectorToken1.address);

    await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_UPGRADER, upgrader.address);
    await converter.addReserve(connectorToken2.address, 500000, false);
    await converter.setConversionFee(CONVERSION_FEE);
    await smartToken.issue(deployer, TOKEN_TOTAL_SUPPLY);
    await connectorToken1.deposit({value: CONNECTOR1_BALANCE});
    await connectorToken1.transfer(converter.address, CONNECTOR1_BALANCE);
    await connectorToken2.transfer(converter.address, CONNECTOR2_BALANCE);

    if (active) {
        await smartToken.transferOwnership(converter.address);
        await converter.acceptTokenOwnership();
    }

    return [upgrader, converter];
}

async function initWithETHReserve(deployer, version, active) {
    if (version) {
        throw new Error(`converter version ${version} does not support ETH-reserve`);
    }

    const smartToken = await SmartToken.new('Smart Token', 'TKN1', 0);
    const connectorToken1 = await ERC20Token.new('ERC Token 1', 'ERC1', 0, CONNECTOR1_BALANCE);
    const converter = await BancorConverter.new(smartToken.address, contractRegistry.address, MAX_CONVERSION_FEE, connectorToken1.address, 500000);
    const upgrader = await BancorConverterUpgrader.new(contractRegistry.address, utils.zeroAddress);

    await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_UPGRADER, upgrader.address);
    await converter.addReserve(ETH_RESERVE_ADDRESS, 500000);
    await converter.setConversionFee(CONVERSION_FEE);
    await smartToken.issue(deployer, TOKEN_TOTAL_SUPPLY);
    await connectorToken1.transfer(converter.address, CONNECTOR1_BALANCE);
    await web3.eth.sendTransaction({from: deployer, to: converter.address, value: CONNECTOR2_BALANCE});

    if (active) {
        await smartToken.transferOwnership(converter.address);
        await converter.acceptTokenOwnership();
    }

    return [upgrader, converter];
}

async function upgradeConverter(upgrader, converter, version, options = {}) {
    let response;

    // for version 11 or higher, we just call upgrade on the converter
    if (converter.upgrade) {
        response = await converter.upgrade(options);
    }
    else {
        // for previous versions we transfer ownership to the upgrader, then call upgradeOld on the upgrader,
        // then accept ownership of the new and old converter. The end results should be the same.
        await converter.transferOwnership(upgrader.address);
        response = await upgrader.upgradeOld(converter.address, web3.fromAscii(''), options);
        await converter.acceptOwnership();
    }

    const logs = response.logs.filter(log => log.event == 'ConverterUpgrade');
    assert.isAtMost(logs.length, 1);
    if (logs.length == 1)
        return BancorConverter.at(logs[0].args._newConverter);

    const newConverterAddress = await new Promise((resolve, reject) => {
        upgrader.ConverterUpgrade({fromBlock: response.receipt.blockNumber, toBlock: response.receipt.blockNumber}).get((error, logs) => {
            assert.equal(error, null);
            assert.equal(logs.length, 1);
            resolve(logs[0].args._newConverter);
        });
    });

    return BancorConverter.at(newConverterAddress);
}

async function getConverterState(converter) {
    const state = {};
    state.owner = await converter.owner();
    state.token = await converter.token();
    state.newOwner = await converter.newOwner();
    state.conversionFee = await converter.conversionFee();
    state.maxConversionFee = await converter.maxConversionFee();
    state.tokenOwner = await SmartToken.at(state.token).owner();
    state.connectorTokenCount = await converter.connectorTokenCount();
    for (let i = 0; i < state.connectorTokenCount; i++) {
        state[`connectorToken${1}`] = await converter.connectorTokens(i);
        state[`connectorToken${2}Balance`] = await converter.getConnectorBalance(state[`connectorToken${1}`]);
    }
    return state;
}

async function assertEqual(actual, expected) {
    for (const key in Object.keys(actual)) {
        if (expected.hasOwnProperty(key))
            assert.equal(actual[key], expected[key]);
    }
}

contract('BancorConverterUpgrader', accounts => {
    const deployer = accounts[0];

    before(async () => {
        contractRegistry = await ContractRegistry.new();
        converterFactory = await BancorConverterFactory.new();
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_FACTORY, converterFactory.address);
    });

    const f = (a, b) => [].concat(...a.map(d => b.map(e => [].concat(d, e))));
    const cartesian = (a, b, ...c) => (b ? cartesian(f(a, b), ...c) : a);
    const product = cartesian([initWithConnectors, initWithoutConnectors, initWithEtherConnector, initWithETHReserve], [...versions, null], [false, true]);
    const combinations = product.filter(([init, version, active]) => !(init == initWithoutConnectors && active) && !(init == initWithETHReserve && version));

    for (const [init, version, active] of combinations) {
        describe(`${init.name}(version = ${version ? version : 'latest'}, active = ${active}):`, () => {
            it('upgrade should complete successfully', async () => {
                const [upgrader, oldConverter] = await init(deployer, version, active);
                const oldConverterInitialState = await getConverterState(oldConverter);
                const newConverter = await upgradeConverter(upgrader, oldConverter, version);
                const oldConverterCurrentState = await getConverterState(oldConverter);
                const newConverterCurrentState = await getConverterState(newConverter);
                assertEqual(oldConverterInitialState, {
                    owner: deployer,
                    newOwner: utils.zeroAddress,
                    tokenOwner: oldConverter.address,
                    conversionFee: CONVERSION_FEE,
                    maxConversionFee: MAX_CONVERSION_FEE,
                    connectorTokenCount: '2',
                    connectorToken1Balance: CONNECTOR1_BALANCE,
                    connectorToken2Balance: CONNECTOR2_BALANCE,
                });
                assertEqual(oldConverterCurrentState, {
                    owner: deployer,
                    newOwner: utils.zeroAddress,
                    token: oldConverterInitialState.token,
                    tokenOwner: newConverter.address,
                    conversionFee: CONVERSION_FEE,
                    maxConversionFee: MAX_CONVERSION_FEE,
                    connectorTokenCount: '2',
                    connectorToken1: oldConverterInitialState.connectorToken1,
                    connectorToken2: oldConverterInitialState.connectorToken2,
                    connectorToken1Balance: '0',
                    connectorToken2Balance: '0',
                });
                assertEqual(newConverterCurrentState, {
                    owner: upgrader.address,
                    newOwner: deployer,
                    token: oldConverterInitialState.token,
                    tokenOwner: newConverter.address,
                    conversionFee: CONVERSION_FEE,
                    maxConversionFee: MAX_CONVERSION_FEE,
                    connectorTokenCount: '2',
                    connectorToken1: oldConverterInitialState.connectorToken1,
                    connectorToken2: oldConverterInitialState.connectorToken2,
                    connectorToken1Balance: CONNECTOR1_BALANCE,
                    connectorToken2Balance: CONNECTOR2_BALANCE,
                });
            });
            it('upgrade should fail if the transaction did not receive enough gas', async () => {
                const [upgrader, oldConverter] = await init(deployer, version, active);
                const oldConverterInitialState = await getConverterState(oldConverter);
                await utils.catchRevert(upgradeConverter(upgrader, oldConverter, version, {gas: 2000000}));
                const oldConverterCurrentState = await getConverterState(oldConverter);
                assertEqual(oldConverterInitialState, oldConverterCurrentState);
            });
            it('upgrade should fail if the upgrader did not receive ownership', async () => {
                const [upgrader, oldConverter] = await init(deployer, version, active);
                const oldConverterInitialState = await getConverterState(oldConverter);
                await utils.catchRevert(upgrader.upgradeOld(oldConverter.address, web3.fromAscii('')));
                const oldConverterCurrentState = await getConverterState(oldConverter);
                assertEqual(oldConverterInitialState, oldConverterCurrentState);
            });
        });
    }
});
