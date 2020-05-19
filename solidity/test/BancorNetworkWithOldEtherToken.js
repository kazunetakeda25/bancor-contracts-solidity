/* global artifacts, contract, before, it, assert, web3 */
/* eslint-disable prefer-reflect */

const utils = require('./helpers/Utils');
const BancorConverter = require('./helpers/BancorConverter');
const ContractRegistryClient = require('./helpers/ContractRegistryClient');

const BancorNetwork = artifacts.require('BancorNetwork');
const SmartToken = artifacts.require('SmartToken');
const BancorFormula = artifacts.require('BancorFormula');
const ContractRegistry = artifacts.require('ContractRegistry');
const EtherToken = artifacts.require('EtherToken');
const TestNonStandardToken = artifacts.require('TestNonStandardToken');

const OLD_CONVERTER_VERSION = 23;

let etherToken;
let smartToken1;
let smartToken2;
let smartToken3;
let smartToken4;
let erc20Token;
let contractRegistry;
let converter1;
let converter2;
let converter3;
let converter4;
let bancorNetwork;
let smartToken1BuyPath;
let smartToken2BuyPath;
let smartToken3BuyPath;
let smartToken1SellPath;
let smartToken2SellPath;
let smartToken3SellPath;
let etherToErc20ConvertPath;

/*
Token network structure:

         SmartToken2
         /         \
    SmartToken1   SmartToken3
          \          \
           \        SmartToken4
            \        /      \
            EtherToken     ERC20Token

*/

contract('BancorNetworkWithOldEtherToken', accounts => {
    const trustedAddress = accounts[3];
    const untrustedAddress = accounts[1];

    before(async () => {
        contractRegistry = await ContractRegistry.new();

        let bancorFormula = await BancorFormula.new();
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_FORMULA, bancorFormula.address);

        bancorNetwork = await BancorNetwork.new(contractRegistry.address);
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_NETWORK, bancorNetwork.address);

        etherToken = await EtherToken.new('Token0', 'TKN0');
        await etherToken.deposit({ value: 10000000 });

        await bancorNetwork.registerEtherToken(etherToken.address, true);

        smartToken1 = await SmartToken.new('Token1', 'TKN1', 2);
        await smartToken1.issue(accounts[0], 1000000);

        smartToken2 = await SmartToken.new('Token2', 'TKN2', 2);
        await smartToken2.issue(accounts[0], 2000000);

        smartToken3 = await SmartToken.new('Token3', 'TKN3', 2);
        await smartToken3.issue(accounts[0], 3000000);

        smartToken4 = await SmartToken.new('Token4', 'TKN4', 2);
        await smartToken4.issue(accounts[0], 2500000);

        await contractRegistry.registerAddress(ContractRegistryClient.BNT_TOKEN, smartToken1.address);

        erc20Token = await TestNonStandardToken.new('ERC20Token', 'ERC5', 2, 1000000);

        converter1 = await BancorConverter.new(0, smartToken1.address, contractRegistry.address, 0, etherToken.address, 250000, OLD_CONVERTER_VERSION);

        converter2 = await BancorConverter.new(1, smartToken2.address, contractRegistry.address, 0, smartToken1.address, 300000, OLD_CONVERTER_VERSION);
        await converter2.addReserve(smartToken3.address, 150000);

        converter3 = await BancorConverter.new(0, smartToken3.address, contractRegistry.address, 0, smartToken4.address, 350000, OLD_CONVERTER_VERSION);

        converter4 = await BancorConverter.new(1, smartToken4.address, contractRegistry.address, 0, etherToken.address, 150000, OLD_CONVERTER_VERSION);
        await converter4.addReserve(erc20Token.address, 220000);

        await etherToken.transfer(converter1.address, 50000);
        await smartToken1.transfer(converter2.address, 40000);
        await smartToken3.transfer(converter2.address, 25000);
        await smartToken4.transfer(converter3.address, 30000);
        await etherToken.transfer(converter4.address, 20000);
        await erc20Token.transfer(converter4.address, 35000);

        await smartToken1.transferOwnership(converter1.address);
        await converter1.acceptTokenOwnership();

        await smartToken2.transferOwnership(converter2.address);
        await converter2.acceptTokenOwnership();

        await smartToken3.transferOwnership(converter3.address);
        await converter3.acceptTokenOwnership();

        await smartToken4.transferOwnership(converter4.address);
        await converter4.acceptTokenOwnership();

        smartToken1BuyPath = [etherToken.address, smartToken1.address, smartToken1.address];
        smartToken2BuyPath = [etherToken.address, smartToken1.address, smartToken1.address, smartToken2.address, smartToken2.address];
        smartToken3BuyPath = [smartToken1.address, smartToken2.address, smartToken2.address, smartToken2.address, smartToken3.address];

        smartToken1SellPath = [smartToken1.address, smartToken1.address, etherToken.address];
        smartToken2SellPath = [smartToken2.address, smartToken2.address, smartToken1.address, smartToken1.address, etherToken.address];
        smartToken3SellPath = [smartToken3.address, smartToken2.address, smartToken2.address, smartToken2.address, smartToken1.address];

        etherToErc20ConvertPath = [etherToken.address, smartToken4.address, erc20Token.address];
    });

    it('verifies that sending ether to the converter fails', async () => {
        await utils.catchRevert(converter2.send(100));
    });

    it('should be able to convert from a non compliant erc-20 to another token', async () => {
        await erc20Token.approve(bancorNetwork.address, 1000);
        let path = [erc20Token.address, smartToken4.address, smartToken4.address];
        let prevBalance = await smartToken4.balanceOf.call(accounts[0]);
        await bancorNetwork.convert(path, 1000, 1);
        let postBalance = await smartToken4.balanceOf.call(accounts[0]);

        assert.isAbove(postBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
    });

    it('should be able to convert from a smart token to a non compliant erc-20', async () => {
        await smartToken4.approve(bancorNetwork.address, 1000);
        let path = [smartToken4.address, smartToken4.address, erc20Token.address];
        let prevBalance = await erc20Token.balanceOf.call(accounts[0]);
        await bancorNetwork.convert(path, 1000, 1);
        let postBalance = await erc20Token.balanceOf.call(accounts[0]);

        assert.isAbove(postBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
    });

    it('verifies that convert with a single converter results in increased balance for the buyer', async () => {
        let prevBalance = await smartToken1.balanceOf.call(accounts[1]);

        let res = await bancorNetwork.convert(smartToken1BuyPath, 100, 1, { from: accounts[1], value: 100 });
        let newBalance = await smartToken1.balanceOf.call(accounts[1]);

        assert.isAbove(newBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
        // console.log(`gas used for converting eth -> 1: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that convert with multiple converters results in increased balance for the buyer', async () => {
        let prevBalance = await smartToken2.balanceOf.call(accounts[1]);

        let res = await bancorNetwork.convert(smartToken2BuyPath, 100, 1, { from: accounts[1], value: 100 });
        let newBalance = await smartToken2.balanceOf.call(accounts[1]);

        assert.isAbove(newBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
        // console.log(`gas used for converting eth -> 1 -> 2: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that convert with minimum return equal to the full expected return amount results in the exact increase in balance for the buyer', async () => {
        let prevBalance = await smartToken2.balanceOf.call(accounts[0]);
        
        let token2Return = (await bancorNetwork.getReturnByPath(smartToken2BuyPath, 100000))[0];

        await bancorNetwork.convert(smartToken2BuyPath, 100000, token2Return, { value: 100000 });
        let newBalance = await smartToken2.balanceOf.call(accounts[0]);

        assert.equal(token2Return.toNumber(), newBalance.toNumber() - prevBalance.toNumber(), "new balance isn't equal to the expected purchase return");
    });

    it('should throw when attempting to convert and the return amount is lower than the given minimum', async () => {
        await utils.catchRevert(bancorNetwork.convert(smartToken2BuyPath, 100, 1000000, { from: accounts[1], value: 100 }));
    });

    it('should throw when attempting to convert and passing an amount higher than the ETH amount sent with the request', async () => {
        await utils.catchRevert(bancorNetwork.convert(smartToken2BuyPath, 100001, 1, { from: accounts[1], value: 100000 }));
    });

    it('verifies the caller balances after selling directly for ether with a single converter', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let prevTokenBalance = await smartToken1.balanceOf.call(accounts[0]);
        let prevETHBalance = web3.eth.getBalance(accounts[0]);

        let res = await bancorNetwork.convert(smartToken1SellPath, 10000, 1);
        let newETHBalance = web3.eth.getBalance(accounts[0]);
        let newTokenBalance = await smartToken1.balanceOf.call(accounts[0]);

        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        assert(newETHBalance.greaterThan(prevETHBalance.minus(transactionCost)), "new ETH balance isn't higher than previous balance");
        assert(newTokenBalance.lessThan(prevTokenBalance), "new token balance isn't lower than previous balance");
    });

    it('verifies the caller balances after selling directly for ether with multiple converters', async () => {
        await smartToken2.approve(bancorNetwork.address, 10000);
        let prevTokenBalance = await smartToken2.balanceOf.call(accounts[0]);
        let prevETHBalance = web3.eth.getBalance(accounts[0]);

        let res = await bancorNetwork.convert(smartToken2SellPath, 10000, 1);
        let newETHBalance = web3.eth.getBalance(accounts[0]);
        let newTokenBalance = await smartToken2.balanceOf.call(accounts[0]);

        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        assert(newETHBalance.greaterThan(prevETHBalance.minus(transactionCost)), "new ETH balance isn't higher than previous balance");
        assert(newTokenBalance.lessThan(prevTokenBalance), "new token balance isn't lower than previous balance");
    });

    it('should throw when attempting to sell directly for ether and the return amount is lower than the given minimum', async () => {
        await smartToken2.approve(bancorNetwork.address, 10000);
        await utils.catchRevert(bancorNetwork.convert(smartToken2SellPath, 10000, 20000));
        await smartToken2.approve(bancorNetwork.address, 0);
    });

    it('verifies the caller balances after converting from one token to another with multiple converters', async () => {
        let path = [smartToken1.address,
                    smartToken2.address, smartToken2.address,
                    smartToken2.address, smartToken3.address,
                    smartToken3.address, smartToken4.address];

        await smartToken1.approve(bancorNetwork.address, 1000);
        let prevToken1Balance = await smartToken1.balanceOf.call(accounts[0]);
        let prevToken4Balance = await smartToken4.balanceOf.call(accounts[0]);

        await bancorNetwork.convert(path, 1000, 1);
        let newToken1Balance = await smartToken1.balanceOf.call(accounts[0]);
        let newToken4Balance = await smartToken4.balanceOf.call(accounts[0]);

        assert(newToken4Balance.greaterThan(prevToken4Balance), "bought token balance isn't higher than previous balance");
        assert(newToken1Balance.lessThan(prevToken1Balance), "sold token balance isn't lower than previous balance");
    });

    it('verifies valid ether token registration', async () => {
        let etherToken1 = await EtherToken.new('Token0', 'TKN0');
        await etherToken1.deposit({ value: 10000000 });
        let bancorNetwork1 = await BancorNetwork.new(contractRegistry.address);
        await bancorNetwork1.registerEtherToken(etherToken1.address, true);
        let validEtherToken = await bancorNetwork1.etherTokens.call(etherToken1.address);
        assert.isTrue(validEtherToken, 'registered etherToken address verification');
    });

    it('should throw when attempting register ether token with invalid address', async () => {
        let bancorNetwork1 = await BancorNetwork.new(contractRegistry.address);
        await utils.catchRevert(bancorNetwork1.registerEtherToken(utils.zeroAddress, true));
    });

    it('should throw when non owner attempting register ether token', async () => {
        let etherToken1 = await EtherToken.new('Token0', 'TKN0');
        await etherToken1.deposit({ value: 10000000 });
        let bancorNetwork1 = await BancorNetwork.new(contractRegistry.address);
        await utils.catchRevert(bancorNetwork1.registerEtherToken(etherToken1.address, true, { from: accounts[1] }));
    });

    it('verifies valid ether token unregistration', async () => {
        let etherToken1 = await EtherToken.new('Token0', 'TKN0');
        await etherToken1.deposit({ value: 10000000 });
        let bancorNetwork1 = await BancorNetwork.new(contractRegistry.address);
        await bancorNetwork1.registerEtherToken(etherToken1.address, true);
        let validEtherToken = await bancorNetwork1.etherTokens.call(etherToken1.address);
        assert.isTrue(validEtherToken, 'registered etherToken address verification');
        await bancorNetwork1.registerEtherToken(etherToken1.address, false);
        let validEtherToken2 = await bancorNetwork1.etherTokens.call(etherToken1.address);
        assert.isNotTrue(validEtherToken2, 'unregistered etherToken address verification');
    });

    it('should throw when non owner attempting to unregister ether token', async () => {
        let etherToken1 = await EtherToken.new('Token0', 'TKN0');
        await etherToken1.deposit({ value: 10000000 });
        let bancorNetwork1 = await BancorNetwork.new(contractRegistry.address);
        await bancorNetwork1.registerEtherToken(etherToken1.address, true);
        let validEtherToken = await bancorNetwork1.etherTokens.call(etherToken1.address);
        assert.isTrue(validEtherToken, 'registered etherToken address verification');
        await utils.catchRevert(bancorNetwork1.registerEtherToken(etherToken1.address, false, { from: accounts[1] }));
    });

    it('verifies that convertFor transfers the converted amount correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor(smartToken1BuyPath, 10000, 1, accounts[1], { value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that convert transfers the converted amount correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convert(smartToken1BuyPath, 10000, 1, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies claimAndConvertFor with a path that starts with a smart token and ends with another smart token', async () => {
        await smartToken4.approve(bancorNetwork.address, 10000);
        let path = [smartToken4.address, smartToken3.address, smartToken3.address, smartToken2.address, smartToken2.address];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.claimAndConvertFor(path, 10000, 1, accounts[1]);
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that convertFor returns a valid amount when buying the smart token', async () => {
        let amount = await bancorNetwork.convertFor.call(smartToken1BuyPath, 10000, 1, accounts[1], { value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convert returns a valid amount when buying the smart token', async () => {
        let amount = await bancorNetwork.convert.call(smartToken1BuyPath, 10000, 1, { from: accounts[1], value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convertFor returns a valid amount when converting from ETH to ERC20', async () => {
        let amount = await bancorNetwork.convertFor.call(etherToErc20ConvertPath, 10000, 1, accounts[1], { value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convert returns a valid amount when converting from ETH to ERC20', async () => {
        let amount = await bancorNetwork.convert.call(etherToErc20ConvertPath, 10000, 1, { from: accounts[1], value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('should throw when calling convertFor with ether token but without sending ether', async () => {
        await utils.catchRevert(bancorNetwork.convertFor(smartToken1BuyPath, 10000, 1, accounts[1]));
    });

    it('should throw when calling convertFor with ether amount different than the amount sent', async () => {
        await utils.catchRevert(bancorNetwork.convertFor.call(smartToken1BuyPath, 20000, 1, accounts[1], { value: 10000 }));
    });

    it('should throw when calling convertFor with invalid path', async () => {
        let invalidPath = [etherToken.address, smartToken1.address];
        await utils.catchRevert(bancorNetwork.convertFor(invalidPath, 10000, 1, accounts[1], { value: 10000 }));
    });

    it('should throw when calling convertFor with invalid long path', async () => {
        let longBuyPath = [];
        for (let i = 0; i < 100; ++i)
            longBuyPath.push(etherToken.address);

        await utils.catchRevert(bancorNetwork.convertFor(longBuyPath, 10000, 1, accounts[1], { value: 10000 }));
    });

    it('should throw when calling convert with ether token but without sending ether', async () => {
        await utils.catchRevert(bancorNetwork.convert(smartToken1BuyPath, 10000, 1, { from: accounts[1] }));
    });

    it('should throw when calling convert with ether amount different than the amount sent', async () => {
        await utils.catchRevert(bancorNetwork.convert.call(smartToken1BuyPath, 20000, 1, { from: accounts[1], value: 10000 }));
    });

    it('should throw when calling convert with invalid path', async () => {
        let invalidPath = [etherToken.address, smartToken1.address];
        await utils.catchRevert(bancorNetwork.convert(invalidPath, 10000, 1, { from: accounts[1], value: 10000 }));
    });

    it('should throw when calling convert with invalid long path', async () => {
        let longBuyPath = [];
        for (let i = 0; i < 100; ++i)
            longBuyPath.push(etherToken.address);

        await utils.catchRevert(bancorNetwork.convert(longBuyPath, 10000, 1, { from: accounts[1], value: 10000 }));
    });

    it('verifies that claimAndConvertFor transfers the converted amount correctly', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[1]);
        await bancorNetwork.claimAndConvertFor(smartToken3BuyPath, 10000, 1, accounts[1]);
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('should throw when calling claimAndConvertFor without approval', async () => {
        await utils.catchRevert(bancorNetwork.claimAndConvertFor(smartToken3BuyPath, 10000, 1, accounts[1]));
    });

    it('verifies that claimAndConvert transfers the converted amount correctly', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[0]);
        await bancorNetwork.claimAndConvert(smartToken3BuyPath, 10000, 1);
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[0]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('should throw when calling claimAndConvert without approval', async () => {
        await utils.catchRevert(bancorNetwork.claimAndConvert(smartToken3BuyPath, 10000, 1));
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor(smartToken1BuyPath, 10000, 1, accounts[1], { value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token through multiple converters', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor(smartToken2BuyPath, 10000, 1, accounts[1], { value: 10000 });
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convert(smartToken1BuyPath, 10000, 1, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token through multiple converters', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.convert(smartToken2BuyPath, 10000, 1, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for cross reserve conversion', async () => {
        await bancorNetwork.convert([etherToken.address, smartToken1.address, smartToken1.address], 1000, 1, { from: accounts[1], value: 1000 });
        await smartToken1.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let path = [smartToken1.address, smartToken2.address, smartToken3.address];
        let returnByPath = (await bancorNetwork.getReturnByPath.call(path, 100))[0];
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[1]);
        await bancorNetwork.convert(path, 100, 1, { from: accounts[1] });
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token', async () => {
        await bancorNetwork.convert(smartToken1BuyPath, 100, 1, { from: accounts[1], value: 100 });
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1SellPath, 100))[0];
        await smartToken1.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert(smartToken1SellPath, 100, 1, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token through multiple converters', async () => {
        await bancorNetwork.convert(smartToken2BuyPath, 100, 1, { from: accounts[1], value: 100 });
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2SellPath, 100))[0];
        await smartToken2.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert(smartToken2SellPath, 100, 1, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
        // console.log(`gas used for converting 2 -> 1 -> eth: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token with a long conversion path', async () => {
        await bancorNetwork.convert([etherToken.address, smartToken1.address, smartToken1.address, smartToken2.address, smartToken3.address], 1000, 1, { from: accounts[1], value: 1000 });
        let path = [smartToken3.address, smartToken2.address, smartToken2.address, smartToken2.address, smartToken1.address, smartToken1.address, etherToken.address];
        let returnByPath = (await bancorNetwork.getReturnByPath.call(path, 100))[0];
        await smartToken3.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert(path, 100, 1, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
        // console.log(`gas used for converting 3 -> 2 -> 1 -> eth: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that getReturnByPath returns the same amount as getReturn when converting a reserve to the smart token', async () => {
        let getReturn = (await converter2.getReturn.call(smartToken1.address, smartToken2.address, 100))[0];
        let returnByPath = (await bancorNetwork.getReturnByPath.call([smartToken1.address, smartToken2.address, smartToken2.address], 100))[0];
        assert.equal(getReturn.toNumber(), returnByPath.toNumber());
    });

    it('verifies that getReturnByPath returns the same amount as getReturn when converting from a token to a reserve', async () => {
        let getReturn = (await converter2.getReturn.call(smartToken2.address, smartToken1.address, 100))[0];
        let returnByPath = (await bancorNetwork.getReturnByPath.call([smartToken2.address, smartToken2.address, smartToken1.address], 100))[0];
        assert.equal(getReturn.toNumber(), returnByPath.toNumber());
    });

    it('should throw when attempting to call getReturnByPath on a path with fewer than 3 elements', async () => {
        let invalidPath = [etherToken.address, smartToken1.address];
        await utils.catchRevert(bancorNetwork.getReturnByPath.call(invalidPath, 1000));
    });

    it('should throw when attempting to call getReturnByPath on a path with an odd number of elements', async () => {
        let invalidPath = [etherToken.address, smartToken1.address, smartToken2.address, smartToken3.address];
        await utils.catchRevert(bancorNetwork.getReturnByPath.call(invalidPath, 1000));
    });

    it('should throw when attempting to get the return by path with invalid long path', async () => {
        let longBuyPath = [];
        for (let i = 0; i < 103; ++i)
            longBuyPath.push(etherToken.address);

        await utils.catchRevert(bancorNetwork.getReturnByPath.call(longBuyPath, 1000));
    });

    it('verifies that convertFor2 transfers the converted amount correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor2(smartToken1BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that convert2 transfers the converted amount correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convert2(smartToken1BuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies claimAndConvertFor2 with a path that starts with a smart token and ends with another smart token', async () => {
        await smartToken4.approve(bancorNetwork.address, 10000);
        let path = [smartToken4.address, smartToken3.address, smartToken3.address, smartToken2.address, smartToken2.address];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.claimAndConvertFor2(path, 10000, 1, accounts[1], utils.zeroAddress, 0);
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that convertFor2 returns a valid amount when buying the smart token', async () => {
        let amount = await bancorNetwork.convertFor2.call(smartToken1BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convert2 returns a valid amount when buying the smart token', async () => {
        let amount = await bancorNetwork.convert2.call(smartToken1BuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convertFor2 returns a valid amount when converting from ETH to ERC20', async () => {
        let amount = await bancorNetwork.convertFor2.call(etherToErc20ConvertPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('verifies that convert2 returns a valid amount when converting from ETH to ERC20', async () => {
        let amount = await bancorNetwork.convert2.call(etherToErc20ConvertPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 });
        assert.isAbove(amount.toNumber(), 0, 'amount converted');
    });

    it('should throw when calling convertFor2 with ether token but without sending ether', async () => {
        await utils.catchRevert(bancorNetwork.convertFor2(smartToken1BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0));
    });

    it('should throw when calling convertFor2 with ether amount different than the amount sent', async () => {
        await utils.catchRevert(bancorNetwork.convertFor2.call(smartToken1BuyPath, 20000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 }));
    });

    it('should throw when calling convertFor2 with invalid path', async () => {
        let invalidPath = [etherToken.address, smartToken1.address];
        await utils.catchRevert(bancorNetwork.convertFor2(invalidPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 }));
    });

    it('should throw when calling convertFor2 with invalid long path', async () => {
        let longBuyPath = [];
        for (let i = 0; i < 100; ++i)
            longBuyPath.push(etherToken.address);

        await utils.catchRevert(bancorNetwork.convertFor2(longBuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 }));
    });

    it('should throw when calling convert2 with ether token but without sending ether', async () => {
        await utils.catchRevert(bancorNetwork.convert2(smartToken1BuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1] }));
    });

    it('should throw when calling convert2 with ether amount different than the amount sent', async () => {
        await utils.catchRevert(bancorNetwork.convert2.call(smartToken1BuyPath, 20000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 }));
    });

    it('should throw when calling convert2 with invalid path', async () => {
        let invalidPath = [etherToken.address, smartToken1.address];
        await utils.catchRevert(bancorNetwork.convert2(invalidPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 }));
    });

    it('should throw when calling convert2 with invalid long path', async () => {
        let longBuyPath = [];
        for (let i = 0; i < 100; ++i)
            longBuyPath.push(etherToken.address);

        await utils.catchRevert(bancorNetwork.convert2(longBuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 }));
    });

    it('verifies that claimAndConvertFor2 transfers the converted amount correctly', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[1]);
        await bancorNetwork.claimAndConvertFor2(smartToken3BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0);
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[1]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('should throw when calling claimAndConvertFor2 without approval', async () => {
        await utils.catchRevert(bancorNetwork.claimAndConvertFor2(smartToken3BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0));
    });

    it('verifies that claimAndConvert2 transfers the converted amount correctly', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[0]);
        await bancorNetwork.claimAndConvert2(smartToken3BuyPath, 10000, 1, utils.zeroAddress, 0);
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[0]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('should throw when calling claimAndConvert2 without approval', async () => {
        await utils.catchRevert(bancorNetwork.claimAndConvert2(smartToken3BuyPath, 10000, 1, utils.zeroAddress, 0));
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor2(smartToken1BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token through multiple converters', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.convertFor2(smartToken2BuyPath, 10000, 1, accounts[1], utils.zeroAddress, 0, { value: 10000 });
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[1]);
        await bancorNetwork.convert2(smartToken1BuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for buying the smart token through multiple converters', async () => {
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2BuyPath, 10000))[0];
        let balanceBeforeTransfer = await smartToken2.balanceOf.call(accounts[1]);
        await bancorNetwork.convert2(smartToken2BuyPath, 10000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken2.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('should be able to convert2 from a non compliant erc-20 to another token', async () => {
        await erc20Token.approve(bancorNetwork.address, 1000);
        let path = [erc20Token.address, smartToken4.address, smartToken4.address];
        let prevBalance = await smartToken4.balanceOf.call(accounts[0]);
        await bancorNetwork.convert2(path, 1000, 1, utils.zeroAddress, 0);
        let postBalance = await smartToken4.balanceOf.call(accounts[0]);

        assert.isAbove(postBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
    });

    it('should be able to convert2 from a smart token to a non compliant erc-20', async () => {
        let path = [smartToken4.address, smartToken4.address, erc20Token.address];
        await smartToken4.approve(bancorNetwork.address, 1000);
        let prevBalance = await erc20Token.balanceOf.call(accounts[0]);
        await bancorNetwork.convert2(path, 1000, 1, utils.zeroAddress, 0);
        let postBalance = await erc20Token.balanceOf.call(accounts[0]);

        assert.isAbove(postBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
    });

    it('verifies that convert2 with a single converter results in increased balance for the buyer', async () => {
        let prevBalance = await smartToken1.balanceOf.call(accounts[1]);

        let res = await bancorNetwork.convert2(smartToken1BuyPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1], value: 100 });
        let newBalance = await smartToken1.balanceOf.call(accounts[1]);

        assert.isAbove(newBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
        // console.log(`gas used for converting eth -> 1: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that convert2 with multiple converters results in increased balance for the buyer', async () => {
        let prevBalance = await smartToken2.balanceOf.call(accounts[1]);

        let res = await bancorNetwork.convert2(smartToken2BuyPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1], value: 100 });
        let newBalance = await smartToken2.balanceOf.call(accounts[1]);

        assert.isAbove(newBalance.toNumber(), prevBalance.toNumber(), "new balance isn't higher than previous balance");
        // console.log(`gas used for converting eth -> 1 -> 2: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that convert2 with minimum return equal to the full expected return amount results in the exact increase in balance for the buyer', async () => {
        let prevBalance = await smartToken2.balanceOf.call(accounts[0]);
        
        let token2Return = (await bancorNetwork.getReturnByPath(smartToken2BuyPath, 100000))[0];

        await bancorNetwork.convert2(smartToken2BuyPath, 100000, token2Return, utils.zeroAddress, 0, { value: 100000 });
        let newBalance = await smartToken2.balanceOf.call(accounts[0]);

        assert.equal(token2Return.toNumber(), newBalance.toNumber() - prevBalance.toNumber(), "new balance isn't equal to the expected purchase return");
    });

    it('should throw when attempting to convert2 and the return amount is lower than the given minimum', async () => {
        await utils.catchRevert(bancorNetwork.convert2(smartToken2BuyPath, 100, 1000000, utils.zeroAddress, 0, { from: accounts[1], value: 100 }));
    });

    it('should throw when attempting to convert2 and passing an amount higher than the ETH amount sent with the request', async () => {
        await utils.catchRevert(bancorNetwork.convert2(smartToken2BuyPath, 100001, 1, utils.zeroAddress, 0, { from: accounts[1], value: 100000 }));
    });

    it('verifies the caller balances after selling directly for ether with a single converter', async () => {
        await smartToken1.approve(bancorNetwork.address, 10000);
        let prevTokenBalance = await smartToken1.balanceOf.call(accounts[0]);
        let prevETHBalance = web3.eth.getBalance(accounts[0]);

        let res = await bancorNetwork.convert2(smartToken1SellPath, 10000, 1, utils.zeroAddress, 0);
        let newETHBalance = web3.eth.getBalance(accounts[0]);
        let newTokenBalance = await smartToken1.balanceOf.call(accounts[0]);

        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        assert(newETHBalance.greaterThan(prevETHBalance.minus(transactionCost)), "new ETH balance isn't higher than previous balance");
        assert(newTokenBalance.lessThan(prevTokenBalance), "new token balance isn't lower than previous balance");
    });

    it('verifies the caller balances after selling directly for ether with multiple converters', async () => {
        await smartToken2.approve(bancorNetwork.address, 10000);
        let prevTokenBalance = await smartToken2.balanceOf.call(accounts[0]);
        let prevETHBalance = web3.eth.getBalance(accounts[0]);

        let res = await bancorNetwork.convert2(smartToken2SellPath, 10000, 1, utils.zeroAddress, 0);
        let newETHBalance = web3.eth.getBalance(accounts[0]);
        let newTokenBalance = await smartToken2.balanceOf.call(accounts[0]);

        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        assert(newETHBalance.greaterThan(prevETHBalance.minus(transactionCost)), "new ETH balance isn't higher than previous balance");
        assert(newTokenBalance.lessThan(prevTokenBalance), "new token balance isn't lower than previous balance");
    });

    it('should throw when attempting to sell directly for ether and the return amount is lower than the given minimum', async () => {
        await smartToken2.approve(bancorNetwork.address, 10000);
        await utils.catchRevert(bancorNetwork.convert2(smartToken2SellPath, 10000, 20000, utils.zeroAddress, 0));
        await smartToken2.approve(bancorNetwork.address, 0);
    });

    it('verifies the caller balances after converting from one token to another with multiple converters', async () => {
        let path = [smartToken1.address,
                    smartToken2.address, smartToken2.address,
                    smartToken2.address, smartToken3.address,
                    smartToken3.address, smartToken4.address];

        await smartToken1.approve(bancorNetwork.address, 1000);

        let prevToken1Balance = await smartToken1.balanceOf.call(accounts[0]);
        let prevToken4Balance = await smartToken4.balanceOf.call(accounts[0]);

        await bancorNetwork.convert2(path, 1000, 1, utils.zeroAddress, 0);
        let newToken1Balance = await smartToken1.balanceOf.call(accounts[0]);
        let newToken4Balance = await smartToken4.balanceOf.call(accounts[0]);

        assert(newToken4Balance.greaterThan(prevToken4Balance), "bought token balance isn't higher than previous balance");
        assert(newToken1Balance.lessThan(prevToken1Balance), "sold token balance isn't lower than previous balance");
    });

    it('verifies that getReturnByPath returns the correct amount for cross reserve conversion', async () => {
        await bancorNetwork.convert2([etherToken.address, smartToken1.address, smartToken1.address], 1000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 1000 });
        await smartToken1.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let path = [smartToken1.address, smartToken2.address, smartToken3.address];
        let returnByPath = (await bancorNetwork.getReturnByPath.call(path, 100))[0];
        let balanceBeforeTransfer = await smartToken3.balanceOf.call(accounts[1]);
        await bancorNetwork.convert2(path, 100, 1, utils.zeroAddress, 0, { from: accounts[1] });
        let balanceAfterTransfer = await smartToken3.balanceOf.call(accounts[1]);
        assert.equal(returnByPath, balanceAfterTransfer - balanceBeforeTransfer);
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token', async () => {
        await bancorNetwork.convert2(smartToken1BuyPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1], value: 100 });
        await smartToken1.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken1SellPath, 100))[0];
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert2(smartToken1SellPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token through multiple converters', async () => {
        await bancorNetwork.convert2(smartToken2BuyPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1], value: 100 });
        await smartToken2.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let returnByPath = (await bancorNetwork.getReturnByPath.call(smartToken2SellPath, 100))[0];
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert2(smartToken2SellPath, 100, 1, utils.zeroAddress, 0, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
        // console.log(`gas used for converting 2 -> 1 -> eth: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that getReturnByPath returns the correct amount for selling the smart token with a long conversion path', async () => {
        await bancorNetwork.convert2([etherToken.address, smartToken1.address, smartToken1.address, smartToken2.address, smartToken3.address], 1000, 1, utils.zeroAddress, 0, { from: accounts[1], value: 1000 });
        await smartToken3.approve(bancorNetwork.address, 100, { from: accounts[1] });
        let path = [smartToken3.address, smartToken2.address, smartToken2.address, smartToken2.address, smartToken1.address, smartToken1.address, etherToken.address];
        let returnByPath = (await bancorNetwork.getReturnByPath.call(path, 100))[0];
        let balanceBeforeTransfer = web3.eth.getBalance(accounts[1]);
        let res = await bancorNetwork.convert2(path, 100, 1, utils.zeroAddress, 0, { from: accounts[1] });
        let transaction = web3.eth.getTransaction(res.tx);
        let transactionCost = transaction.gasPrice.times(res.receipt.cumulativeGasUsed);
        let balanceAfterTransfer = web3.eth.getBalance(accounts[1]);
        assert.equal(returnByPath.toNumber(), balanceAfterTransfer.minus(balanceBeforeTransfer).plus(transactionCost).toNumber());
        // console.log(`gas used for converting 3 -> 2 -> 1 -> eth: ${res.receipt.cumulativeGasUsed}`);
    });

    it('verifies that convertFor2 transfers the affiliate fee correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[2]);
        await bancorNetwork.convertFor2(smartToken1BuyPath, 10000, 1, accounts[1], accounts[2], 10000, { value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[2]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that convert2 transfers the affiliate fee correctly', async () => {
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[2]);
        await bancorNetwork.convert2(smartToken1BuyPath, 10000, 1, accounts[2], 10000, { from: accounts[1], value: 10000 });
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[2]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that claimAndConvert2 transfers the affiliate fee correctly', async () => {
        await smartToken3.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[2]);
        await bancorNetwork.claimAndConvert2(smartToken3SellPath, 10000, 1, accounts[2], 10000);
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[2]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that claimAndConvertFor2 transfers the affiliate fee correctly', async () => {
        await smartToken3.approve(bancorNetwork.address, 10000);
        let balanceBeforeTransfer = await smartToken1.balanceOf.call(accounts[2]);
        await bancorNetwork.claimAndConvertFor2(smartToken3SellPath, 10000, 1, accounts[1], accounts[2], 10000);
        let balanceAfterTransfer = await smartToken1.balanceOf.call(accounts[2]);
        assert.isAbove(balanceAfterTransfer.toNumber(), balanceBeforeTransfer.toNumber(), 'amount transfered');
    });

    it('verifies that setMaxAffiliateFee can set the maximum affiliate-fee', async () => {
        let oldMaxAffiliateFee = await bancorNetwork.maxAffiliateFee.call();
        await bancorNetwork.setMaxAffiliateFee(oldMaxAffiliateFee.plus(1));
        let newMaxAffiliateFee = await bancorNetwork.maxAffiliateFee.call();
        await bancorNetwork.setMaxAffiliateFee(oldMaxAffiliateFee);
        assert.equal(newMaxAffiliateFee.toString(), oldMaxAffiliateFee.plus(1));
    });

    it('should throw when calling setMaxAffiliateFee with a non-owner or an illegal value', async () => {
        await utils.catchRevert(bancorNetwork.setMaxAffiliateFee("1000000", { from: accounts[1] }));
        await utils.catchRevert(bancorNetwork.setMaxAffiliateFee("1000001", { from: accounts[0] }));
    });
});
