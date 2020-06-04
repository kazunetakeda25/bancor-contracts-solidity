/* global artifacts, contract, before, it, assert */
/* eslint-disable prefer-reflect */

const utils = require('./helpers/Utils');
const ContractRegistryClient = require('./helpers/ContractRegistryClient');
const BancorNetwork = artifacts.require('BancorNetwork');
const LiquidityPoolV1Converter = artifacts.require('LiquidityPoolV1Converter');
const LiquidityPoolV1ConverterFactory = artifacts.require('LiquidityPoolV1ConverterFactory');
const SmartToken = artifacts.require('SmartToken');
const BancorFormula = artifacts.require('BancorFormula');
const ContractRegistry = artifacts.require('ContractRegistry');
const ERC20Token = artifacts.require('ERC20Token');
const TestNonStandardToken = artifacts.require('TestNonStandardToken');
const ConverterFactory = artifacts.require('ConverterFactory');
const ConverterUpgrader = artifacts.require('ConverterUpgrader');

const ETH_RESERVE_ADDRESS = '0x'.padEnd(42, 'e');

let bancorNetwork;
let factory;
let token;
let tokenAddress;
let contractRegistry;
let reserveToken;
let reserveToken2;
let reserveToken3;
let upgrader;


async function createConverter(tokenAddress, registryAddress = contractRegistry.address, maxConversionFee = 0) {
    return await LiquidityPoolV1Converter.new(tokenAddress, registryAddress, maxConversionFee);
}

async function initConverter(accounts, activate, isETHReserve, maxConversionFee = 0) {
    token = await SmartToken.new('Token1', 'TKN1', 2);
    tokenAddress = token.address;

    let converter = await createConverter(tokenAddress, contractRegistry.address, maxConversionFee);
    await converter.addReserve(getReserve1Address(isETHReserve), 250000);
    await converter.addReserve(reserveToken2.address, 150000);
    await reserveToken2.transfer(converter.address, 8000);
    await token.issue(accounts[0], 20000);

    if (isETHReserve)
        await converter.send(5000);
    else
        await reserveToken.transfer(converter.address, 5000);

    if (activate) {
        await token.transferOwnership(converter.address);
        await converter.acceptTokenOwnership();
    }

    return converter;
}

function getReserve1Address(isETH) {
    if (isETH)
        return ETH_RESERVE_ADDRESS;

    return reserveToken.address;
}

async function getBalance(token, address, account) {
    if (address == ETH_RESERVE_ADDRESS)
        return await web3.eth.getBalance(account);

    return await token.balanceOf.call(account);
}

async function getTransactionCost(txResult) {
    let transaction = await web3.eth.getTransaction(txResult.tx);
    return transaction.gasPrice.times(txResult.receipt.cumulativeGasUsed);
}

async function approve(token, from, to, amount) {
    await token.approve(to, 0, { from });
    return await token.approve(to, amount, { from });
}

async function convert(path, amount, minReturn, options) {
    return bancorNetwork.convertByPath(path, amount, minReturn, utils.zeroAddress, utils.zeroAddress, 0, options);
}

contract('LiquidityPoolV1Converter', accounts => {
    before(async () => {
        contractRegistry = await ContractRegistry.new();

        let bancorFormula = await BancorFormula.new();
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_FORMULA, bancorFormula.address);

        bancorNetwork = await BancorNetwork.new(contractRegistry.address);
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_NETWORK, bancorNetwork.address);

        factory = await ConverterFactory.new();
        await contractRegistry.registerAddress(ContractRegistryClient.CONVERTER_FACTORY, factory.address);

        await factory.registerTypedConverterFactory((await LiquidityPoolV1ConverterFactory.new()).address);

        upgrader = await ConverterUpgrader.new(contractRegistry.address, utils.zeroAddress);
        await contractRegistry.registerAddress(ContractRegistryClient.CONVERTER_UPGRADER, upgrader.address);

        let token = await SmartToken.new('Token1', 'TKN1', 2); 
        tokenAddress = token.address;

        reserveToken = await ERC20Token.new('ERC Token 1', 'ERC1', 0, 1000000000);
        reserveToken2 = await TestNonStandardToken.new('ERC Token 2', 'ERC2', 0, 2000000000);
        reserveToken3 = await ERC20Token.new('ERC Token 3', 'ERC3', 0, 1500000000);
    });

    for (let isETHReserve = 0; isETHReserve < 2; isETHReserve++) {
        describe(`${isETHReserve == 0 ? '(with ERC20 reserves)' : '(with ETH reserve)'}:`, () => {

            it('verifies that convert returns valid amount and fee after converting', async () => {
                let converter = await initConverter(accounts, true, isETHReserve, 5000);
                let watcher = converter.Conversion();
                await converter.setConversionFee(3000);
                
                let value = 0;
                if (isETHReserve)
                    value = 500;
                else
                    await approve(reserveToken, accounts[0], bancorNetwork.address, 500);

                await convert([getReserve1Address(isETHReserve), tokenAddress, reserveToken2.address], 500, 1, { value });
                let events = await watcher.get();
                assert(events.length > 0);
                assert(events[0].args._return.equals(1171), events[0].args._conversionFee.equals(8));
            });

            it('should throw when attempting to convert when the return is smaller than the minimum requested amount', async () => {
                await initConverter(accounts, true, isETHReserve);
                let value = 0;
                if (isETHReserve)
                    value = 500;
                else
                    await approve(reserveToken, accounts[0], bancorNetwork.address, 500);

                await utils.catchRevert(convert([getReserve1Address(isETHReserve), tokenAddress, reserveToken2.address], 500, 2000, { value }));
            });

            for (const percent of [50, 75, 100]) {
                it(`verifies that fund executes when the reserve ratio equals ${percent}%`, async () => {
                    let converter = await initConverter(accounts, false, isETHReserve);
                    await converter.addReserve(reserveToken3.address, (percent - 40) * 10000);

                    await reserveToken3.transfer(converter.address, 6000);

                    await token.transferOwnership(converter.address);
                    await converter.acceptTokenOwnership();

                    let prevBalance = await token.balanceOf.call(accounts[0]);

                    let value = 0;
                    if (isETHReserve)
                        value = 100000;
                    else
                        await approve(reserveToken, accounts[0], converter.address, 100000);

                    await approve(reserveToken2, accounts[0], converter.address, 100000);
                    await approve(reserveToken3, accounts[0], converter.address, 100000);
                    await converter.fund(100, { value });
                    let balance = await token.balanceOf.call(accounts[0]);

                    assert.equal(balance.toNumber(), prevBalance.toNumber() + 100);
                });
            }

            it('verifies that fund gets the correct reserve balance amounts from the caller', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(accounts[9], 5000);
                await reserveToken2.transfer(accounts[9], 5000);
                await reserveToken3.transfer(accounts[9], 5000);

                let supply = await token.totalSupply.call();
                let percentage = 100 / (supply / 19);
                let prevReserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let prevReserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let prevReserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                let token1Amount = prevReserve1Balance * percentage / 100;
                let token2Amount = prevReserve2Balance * percentage / 100;
                let token3Amount = prevReserve3Balance * percentage / 100;

                let value = 0;
                if (isETHReserve)
                    value = 100000;
                else
                    await approve(reserveToken, accounts[9], converter.address, 100000);

                await approve(reserveToken2, accounts[9], converter.address, 100000);
                await approve(reserveToken3, accounts[9], converter.address, 100000);
                await converter.fund(19, { from: accounts[9], value });

                let reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                assert.equal(reserve1Balance.toFixed(), prevReserve1Balance.plus(Math.ceil(token1Amount)).toFixed());
                assert.equal(reserve2Balance.toFixed(), prevReserve2Balance.plus(Math.ceil(token2Amount)).toFixed());
                assert.equal(reserve3Balance.toFixed(), prevReserve3Balance.plus(Math.ceil(token3Amount)).toFixed());

                let token1Balance = await reserveToken.balanceOf.call(accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                await reserveToken.transfer(accounts[0], token1Balance, { from: accounts[9] });
                await reserveToken2.transfer(accounts[0], token2Balance, { from: accounts[9] });
                await reserveToken3.transfer(accounts[0], token3Balance, { from: accounts[9] });
            });

            it('verifies that increasing the liquidity by a large amount gets the correct reserve balance amounts from the caller', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(accounts[9], 500000);
                await reserveToken2.transfer(accounts[9], 500000);
                await reserveToken3.transfer(accounts[9], 500000);

                let supply = await token.totalSupply.call();
                let percentage = 100 / (supply / 140854);
                let prevReserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let prevReserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let prevReserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                let token1Amount = prevReserve1Balance * percentage / 100;
                let token2Amount = prevReserve2Balance * percentage / 100;
                let token3Amount = prevReserve3Balance * percentage / 100;

                let value = 0;
                if (isETHReserve)
                    value = 100000;
                else
                    await approve(reserveToken, accounts[9], converter.address, 100000);

                await approve(reserveToken2, accounts[9], converter.address, 100000);
                await approve(reserveToken3, accounts[9], converter.address, 100000);
                await converter.fund(140854, { from: accounts[9], value });

                let reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                assert.equal(reserve1Balance.toFixed(), prevReserve1Balance.plus(Math.ceil(token1Amount)).toFixed());
                assert.equal(reserve2Balance.toFixed(), prevReserve2Balance.plus(Math.ceil(token2Amount)).toFixed());
                assert.equal(reserve3Balance.toFixed(), prevReserve3Balance.plus(Math.ceil(token3Amount)).toFixed());

                let token1Balance = await reserveToken.balanceOf.call(accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                await reserveToken.transfer(accounts[0], token1Balance, { from: accounts[9] });
                await reserveToken2.transfer(accounts[0], token2Balance, { from: accounts[9] });
                await reserveToken3.transfer(accounts[0], token3Balance, { from: accounts[9] });
            });

            it('should throw when attempting to fund the converter with insufficient funds', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(accounts[9], 100);
                await reserveToken2.transfer(accounts[9], 100);
                await reserveToken3.transfer(accounts[9], 100);

                let value = 0;
                if (isETHReserve)
                    value = 100000;
                else
                    await approve(reserveToken, accounts[9], converter.address, 100000);

                await approve(reserveToken2, accounts[9], converter.address, 100000);
                await approve(reserveToken3, accounts[9], converter.address, 100000);
                await converter.fund(5, { from: accounts[9], value });

                await utils.catchRevert(converter.fund(600, { from: accounts[9], value }));
                let token1Balance = await reserveToken.balanceOf.call(accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                await reserveToken.transfer(accounts[0], token1Balance, { from: accounts[9] });
                await reserveToken2.transfer(accounts[0], token2Balance, { from: accounts[9] });
                await reserveToken3.transfer(accounts[0], token3Balance, { from: accounts[9] });
                
            });

            for (const percent of [50, 75, 100]) {
                it(`verifies that liquidate executes when the reserve ratio equals ${percent}%`, async () => {
                    let converter = await initConverter(accounts, false, isETHReserve);
                    await converter.addReserve(reserveToken3.address, (percent - 40) * 10000);

                    await reserveToken3.transfer(converter.address, 6000);

                    await token.transferOwnership(converter.address);
                    await converter.acceptTokenOwnership();

                    let prevSupply = await token.totalSupply.call();
                    await converter.liquidate(100);
                    let supply = await token.totalSupply();

                    assert.equal(prevSupply - 100, supply);
                });
            }

            it('verifies that liquidate sends the correct reserve balance amounts to the caller', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(accounts[9], 100);

                let supply = await token.totalSupply.call();
                let percentage = 100 / (supply / 19);
                let reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                let token1Amount = reserve1Balance * percentage / 100;
                let token2Amount = reserve2Balance * percentage / 100;
                let token3Amount = reserve3Balance * percentage / 100;

                let token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2PrevBalance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3PrevBalance = await reserveToken3.balanceOf.call(accounts[9]);
                let res = await converter.liquidate(19, { from: accounts[9] });

                let transactionCost = 0;
                if (isETHReserve)
                    transactionCost = await getTransactionCost(res);

                let token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                assert(token1PrevBalance.plus(Math.floor(token1Amount)).minus(transactionCost).equals(token1Balance));
                assert(token2PrevBalance.plus(Math.floor(token2Amount)).equals(token2Balance));
                assert(token3PrevBalance.plus(Math.floor(token3Amount)).equals(token3Balance));
            });

            it('verifies that liquidating a large amount sends the correct reserve balance amounts to the caller', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(accounts[9], 15000);

                let supply = await token.totalSupply.call();
                let percentage = 100 / (supply / 14854);
                let reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                let token1Amount = reserve1Balance * percentage / 100;
                let token2Amount = reserve2Balance * percentage / 100;
                let token3Amount = reserve3Balance * percentage / 100;

                let token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2PrevBalance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3PrevBalance = await reserveToken3.balanceOf.call(accounts[9]);
                let res = await converter.liquidate(14854, { from: accounts[9] });

                let transactionCost = 0;
                if (isETHReserve)
                    transactionCost = await getTransactionCost(res);

                let token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                assert(token1PrevBalance.plus(Math.floor(token1Amount)).minus(transactionCost).equals(token1Balance));
                assert(token2PrevBalance.plus(Math.floor(token2Amount)).equals(token2Balance));
                assert(token3PrevBalance.plus(Math.floor(token3Amount)).equals(token3Balance));
            });

            it('verifies that liquidating the entire supply sends the full reserve balances to the caller', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(accounts[9], 20000);

                let reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                let reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                let reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                let token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2PrevBalance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3PrevBalance = await reserveToken3.balanceOf.call(accounts[9]);
                let res = await converter.liquidate(20000, { from: accounts[9] });

                let transactionCost = 0;
                if (isETHReserve)
                    transactionCost = await getTransactionCost(res);

                let supply = await token.totalSupply.call();
                let token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), accounts[9]);
                let token2Balance = await reserveToken2.balanceOf.call(accounts[9]);
                let token3Balance = await reserveToken3.balanceOf.call(accounts[9]);

                assert.equal(supply, 0);
                assert(token1PrevBalance.plus(reserve1Balance).minus(transactionCost).equals(token1Balance));
                assert(token2PrevBalance.plus(reserve2Balance).equals(token2Balance));
                assert(token3PrevBalance.plus(reserve3Balance).equals(token3Balance));
            });

            it('should throw when attempting to liquidate with insufficient funds', async () => {
                let converter = await initConverter(accounts, false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(accounts[9], 100);

                await converter.liquidate(5, { from: accounts[9] });

                await utils.catchRevert(converter.liquidate(600, { from: accounts[9] }));
            });
        });
    }
});
