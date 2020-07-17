const { expect } = require('chai');
const { expectRevert, expectEvent, constants, BN, balance } = require('@openzeppelin/test-helpers');

const { ETH_RESERVE_ADDRESS, registry } = require('./helpers/Constants');
const { ZERO_ADDRESS } = constants;

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

contract('LiquidityPoolV1Converter', accounts => {
    const createConverter = async (tokenAddress, registryAddress = contractRegistry.address, maxConversionFee = 0) => {
        return LiquidityPoolV1Converter.new(tokenAddress, registryAddress, maxConversionFee);
    };

    const initConverter = async (activate, isETHReserve, maxConversionFee = 0) => {
        token = await SmartToken.new('Token1', 'TKN1', 2);
        tokenAddress = token.address;

        const converter = await createConverter(tokenAddress, contractRegistry.address, maxConversionFee);
        await converter.addReserve(getReserve1Address(isETHReserve), 250000);
        await converter.addReserve(reserveToken2.address, 150000);
        await reserveToken2.transfer(converter.address, 8000);
        await token.issue(sender, 20000);

        if (isETHReserve) {
            await converter.send(5000);
        } else {
            await reserveToken.transfer(converter.address, 5000);
        }

        if (activate) {
            await token.transferOwnership(converter.address);
            await converter.acceptTokenOwnership();
        }

        return converter;
    };

    const getReserve1Address = (isETH) => {
        return isETH ? ETH_RESERVE_ADDRESS : reserveToken.address;
    };

    const getBalance = async (token, address, account) => {
        if (address === ETH_RESERVE_ADDRESS) {
            return balance.current(account);
        }

        return token.balanceOf.call(account);
    };

    const getTransactionCost = async (txResult) => {
        const transaction = await web3.eth.getTransaction(txResult.tx);
        return new BN(transaction.gasPrice).mul(new BN(txResult.receipt.cumulativeGasUsed));
    };

    const convert = async (path, amount, minReturn, options = {}) => {
        return bancorNetwork.convertByPath(path, amount, minReturn, ZERO_ADDRESS, ZERO_ADDRESS, 0, options);
    };

    const divCeil = (num, d) => {
        const dm = num.divmod(d);
        if (dm.mod.isZero()) {
            return dm.div;
        }

        return dm.div.negative !== 0 ? dm.div.isubn(1) : dm.div.iaddn(1);
    };

    let bancorNetwork;
    let token;
    let tokenAddress;
    let contractRegistry;
    let reserveToken;
    let reserveToken2;
    let reserveToken3;
    let upgrader;
    const sender = accounts[0];
    const sender2 = accounts[9];

    const MIN_RETURN = new BN(1);
    const WEIGHT_RESOLUTION = new BN(1000000);

    before(async () => {
        // The following contracts are unaffected by the underlying tests, this can be shared.
        const bancorFormula = await BancorFormula.new();
        await bancorFormula.init();
        contractRegistry = await ContractRegistry.new();

        await contractRegistry.registerAddress(registry.BANCOR_FORMULA, bancorFormula.address);

        const factory = await ConverterFactory.new();
        await contractRegistry.registerAddress(registry.CONVERTER_FACTORY, factory.address);

        await factory.registerTypedConverterFactory((await LiquidityPoolV1ConverterFactory.new()).address);
    });

    beforeEach(async () => {
        bancorNetwork = await BancorNetwork.new(contractRegistry.address);
        await contractRegistry.registerAddress(registry.BANCOR_NETWORK, bancorNetwork.address);

        upgrader = await ConverterUpgrader.new(contractRegistry.address, ZERO_ADDRESS);
        await contractRegistry.registerAddress(registry.CONVERTER_UPGRADER, upgrader.address);

        const token = await SmartToken.new('Token1', 'TKN1', 2);
        tokenAddress = token.address;

        reserveToken = await ERC20Token.new('ERC Token 1', 'ERC1', 0, 1000000000);
        reserveToken2 = await TestNonStandardToken.new('ERC Token 2', 'ERC2', 0, 2000000000);
        reserveToken3 = await ERC20Token.new('ERC Token 3', 'ERC3', 0, 1500000000);
    });

    it('verifies the TokenRateUpdate event after adding liquidity', async () => {
        const converter = await initConverter(true, false);

        const value = new BN(500);
        await reserveToken.approve(converter.address, value, { from: sender });
        await reserveToken2.approve(converter.address, value, { from: sender });

        const res = await converter.addLiquidity([reserveToken.address, reserveToken2.address], [value, value], MIN_RETURN);

        const poolTokenSupply = await token.totalSupply.call();
        const reserve1Balance = await converter.reserveBalance.call(reserveToken.address);
        const reserve1Weight = await converter.reserveWeight.call(reserveToken.address);
        const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
        const reserve2Weight = await converter.reserveWeight.call(reserveToken2.address);

        expectEvent(res, 'TokenRateUpdate', {
            _token1: tokenAddress,
            _token2: reserveToken.address,
            _rateN: reserve1Balance.mul(WEIGHT_RESOLUTION),
            _rateD: poolTokenSupply.mul(reserve1Weight)
        });

        expectEvent(res, 'TokenRateUpdate', {
            _token1: tokenAddress,
            _token2: reserveToken2.address,
            _rateN: reserve2Balance.mul(WEIGHT_RESOLUTION),
            _rateD: poolTokenSupply.mul(reserve2Weight)
        });
    });

    it('verifies the TokenRateUpdate event after removing liquidity', async () => {
        const converter = await initConverter(true, false);

        const res = await converter.removeLiquidity(100, [reserveToken.address, reserveToken2.address], [MIN_RETURN, MIN_RETURN]);

        const poolTokenSupply = await token.totalSupply.call();
        const reserve1Balance = await converter.reserveBalance.call(reserveToken.address);
        const reserve1Weight = await converter.reserveWeight.call(reserveToken.address);
        const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
        const reserve2Weight = await converter.reserveWeight.call(reserveToken2.address);

        expectEvent(res, 'TokenRateUpdate', {
            _token1: tokenAddress,
            _token2: reserveToken.address,
            _rateN: reserve1Balance.mul(WEIGHT_RESOLUTION),
            _rateD: poolTokenSupply.mul(reserve1Weight)
        });

        expectEvent(res, 'TokenRateUpdate', {
            _token1: tokenAddress,
            _token2: reserveToken2.address,
            _rateN: reserve2Balance.mul(WEIGHT_RESOLUTION),
            _rateD: poolTokenSupply.mul(reserve2Weight)
        });
    });

    for (let isETHReserve = 0; isETHReserve < 2; isETHReserve++) {
        describe(`${isETHReserve === 0 ? '(with ERC20 reserves)' : '(with ETH reserve)'}:`, () => {
            it('verifies that convert returns valid amount and fee after converting', async () => {
                const converter = await initConverter(true, isETHReserve, 5000);
                await converter.setConversionFee(3000);

                const amount = new BN(500);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(bancorNetwork.address, amount, { from: sender });
                }

                const purchaseAmount = (await converter.targetAmountAndFee.call(getReserve1Address(isETHReserve), reserveToken2.address, amount))[0];
                const res = await convert([getReserve1Address(isETHReserve), tokenAddress, reserveToken2.address], amount, MIN_RETURN, { value });
                expectEvent(res, 'Conversion', {
                    _smartToken: token.address,
                    _fromToken: getReserve1Address(isETHReserve),
                    _toToken: reserveToken2.address,
                    _fromAmount: amount,
                    _toAmount: purchaseAmount
                });
            });

            it('verifies the TokenRateUpdate event after conversion', async () => {
                const converter = await initConverter(true, isETHReserve, 10000);
                await converter.setConversionFee(6000);

                const amount = new BN(500);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(bancorNetwork.address, amount, { from: sender });
                }

                const res = await convert([getReserve1Address(isETHReserve), tokenAddress, reserveToken2.address], amount, MIN_RETURN, { value });

                const poolTokenSupply = await token.totalSupply.call();
                const reserve1Balance = await converter.reserveBalance(getReserve1Address(isETHReserve));
                const reserve1Weight = await converter.reserveWeight(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance(reserveToken2.address);
                const reserve2Weight = await converter.reserveWeight(reserveToken2.address);

                const events = await converter.getPastEvents('TokenRateUpdate', {
                    fromBlock: res.receipt.blockNumber,
                    toBlock: res.receipt.blockNumber
                });

                // TokenRateUpdate for [source, target):
                const { args: event1 } = events[0];
                expect(event1._token1).to.eql(getReserve1Address(isETHReserve));
                expect(event1._token2).to.eql(reserveToken2.address);
                expect(event1._rateN).to.be.bignumber.equal(reserve2Balance.mul(reserve1Weight));
                expect(event1._rateD).to.be.bignumber.equal(reserve1Balance.mul(reserve2Weight));

                // TokenRateUpdate for [source, pool token):
                const { args: event2 } = events[1];
                expect(event2._token1).to.eql(tokenAddress);
                expect(event2._token2).to.eql(getReserve1Address(isETHReserve));
                expect(event2._rateN).to.be.bignumber.equal(reserve1Balance.mul(WEIGHT_RESOLUTION));
                expect(event2._rateD).to.be.bignumber.equal(poolTokenSupply.mul(reserve1Weight));

                // TokenRateUpdate for [pool token, target):
                const { args: event3 } = events[2];
                expect(event3._token1).to.eql(tokenAddress);
                expect(event3._token2).to.eql(reserveToken2.address);
                expect(event3._rateN).to.be.bignumber.equal(reserve2Balance.mul(WEIGHT_RESOLUTION));
                expect(event3._rateD).to.be.bignumber.equal(poolTokenSupply.mul(reserve2Weight));
            });

            it('should revert when attempting to convert when the return is smaller than the minimum requested amount', async () => {
                await initConverter(true, isETHReserve);

                const amount = new BN(500);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(bancorNetwork.address, amount, { from: sender });
                }

                await expectRevert(convert([getReserve1Address(isETHReserve), tokenAddress, reserveToken2.address],
                    amount, 200000, { value }), 'ERR_RETURN_TOO_LOW');
            });

            for (const percent of [50, 75, 100]) {
                it(`verifies that fund executes when the reserve ratio equals ${percent}%`, async () => {
                    const converter = await initConverter(false, isETHReserve);
                    await converter.addReserve(reserveToken3.address, (percent - 40) * 10000);

                    await reserveToken3.transfer(converter.address, 6000);

                    await token.transferOwnership(converter.address);
                    await converter.acceptTokenOwnership();

                    const prevBalance = await token.balanceOf.call(sender);

                    const amount = new BN(100000);
                    let value = 0;
                    if (isETHReserve) {
                        value = amount;
                    } else {
                        await reserveToken.approve(converter.address, amount, { from: sender });
                    }

                    await reserveToken2.approve(converter.address, amount, { from: sender });
                    await reserveToken3.approve(converter.address, amount, { from: sender });

                    const amount2 = new BN(100);
                    await converter.fund(amount2, { value });

                    const balance = await token.balanceOf.call(sender);
                    expect(balance).to.be.bignumber.equal(prevBalance.add(amount2));
                });
            }

            it('verifies that fund gets the correct reserve balance amounts from the caller', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(sender2, 5000);
                await reserveToken2.transfer(sender2, 5000);
                await reserveToken3.transfer(sender2, 5000);

                const supply = await token.totalSupply.call();
                const percentage = new BN(19);
                const prevReserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const prevReserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const prevReserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                const token1Amount = divCeil(prevReserve1Balance.mul(percentage), supply);
                const token2Amount = divCeil(prevReserve2Balance.mul(percentage), supply);
                const token3Amount = divCeil(prevReserve3Balance.mul(percentage), supply);

                const amount = new BN(100000);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(converter.address, amount, { from: sender2 });
                }

                await reserveToken2.approve(converter.address, amount, { from: sender2 });
                await reserveToken3.approve(converter.address, amount, { from: sender2 });
                await converter.fund(percentage, { from: sender2, value });

                const reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                expect(reserve1Balance).to.be.bignumber.equal(prevReserve1Balance.add(token1Amount));
                expect(reserve2Balance).to.be.bignumber.equal(prevReserve2Balance.add(token2Amount));
                expect(reserve3Balance).to.be.bignumber.equal(prevReserve3Balance.add(token3Amount));
            });

            it('verifies that increasing the liquidity by a large amount gets the correct reserve balance amounts from the caller', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(sender2, 500000);
                await reserveToken2.transfer(sender2, 500000);
                await reserveToken3.transfer(sender2, 500000);

                const supply = await token.totalSupply.call();
                const percentage = new BN(140854);
                const prevReserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const prevReserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const prevReserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                const token1Amount = divCeil(prevReserve1Balance.mul(percentage), supply);
                const token2Amount = divCeil(prevReserve2Balance.mul(percentage), supply);
                const token3Amount = divCeil(prevReserve3Balance.mul(percentage), supply);

                const amount = new BN(100000);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(converter.address, amount, { from: sender2 });
                }

                await reserveToken2.approve(converter.address, amount, { from: sender2 });
                await reserveToken3.approve(converter.address, amount, { from: sender2 });
                await converter.fund(percentage, { from: sender2, value });

                const reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                expect(reserve1Balance).to.be.bignumber.equal(prevReserve1Balance.add(token1Amount));
                expect(reserve2Balance).to.be.bignumber.equal(prevReserve2Balance.add(token2Amount));
                expect(reserve3Balance).to.be.bignumber.equal(prevReserve3Balance.add(token3Amount));
            });

            it('should revert when attempting to fund the converter with insufficient funds', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await reserveToken.transfer(sender2, 100);
                await reserveToken2.transfer(sender2, 100);
                await reserveToken3.transfer(sender2, 100);

                const amount = new BN(100000);
                let value = 0;
                if (isETHReserve) {
                    value = amount;
                } else {
                    await reserveToken.approve(converter.address, amount, { from: sender2 });
                }

                await reserveToken2.approve(converter.address, amount, { from: sender2 });
                await reserveToken3.approve(converter.address, amount, { from: sender2 });
                await converter.fund(5, { from: sender2, value });

                await expectRevert.unspecified(converter.fund(600, { from: sender2, value }));
            });

            for (const percent of [50, 75, 100]) {
                it(`verifies that liquidate executes when the reserve ratio equals ${percent}%`, async () => {
                    const converter = await initConverter(false, isETHReserve);
                    await converter.addReserve(reserveToken3.address, (percent - 40) * 10000);

                    await reserveToken3.transfer(converter.address, 6000);

                    await token.transferOwnership(converter.address);
                    await converter.acceptTokenOwnership();

                    const prevSupply = await token.totalSupply.call();
                    await converter.liquidate(100);
                    const supply = await token.totalSupply.call();

                    expect(prevSupply).to.be.bignumber.equal(supply.add(new BN(100)));
                });
            }

            it('verifies that liquidate sends the correct reserve balance amounts to the caller', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(sender2, 100);

                const supply = await token.totalSupply.call();
                const percentage = new BN(19);
                const reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                const token1Amount = reserve1Balance.mul(percentage).div(supply);
                const token2Amount = reserve2Balance.mul(percentage).div(supply);
                const token3Amount = reserve3Balance.mul(percentage).div(supply);

                const token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2PrevBalance = await reserveToken2.balanceOf.call(sender2);
                const token3PrevBalance = await reserveToken3.balanceOf.call(sender2);
                const res = await converter.liquidate(percentage, { from: sender2 });

                let transactionCost = new BN(0);
                if (isETHReserve) {
                    transactionCost = await getTransactionCost(res);
                }

                const token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2Balance = await reserveToken2.balanceOf.call(sender2);
                const token3Balance = await reserveToken3.balanceOf.call(sender2);

                expect(token1Balance).to.be.bignumber.equal(token1PrevBalance.add(token1Amount.sub(transactionCost)));
                expect(token2Balance).to.be.bignumber.equal(token2PrevBalance.add(token2Amount));
                expect(token3Balance).to.be.bignumber.equal(token3PrevBalance.add(token3Amount));
            });

            it('verifies that liquidating a large amount sends the correct reserve balance amounts to the caller', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(sender2, 15000);

                const supply = await token.totalSupply.call();
                const percentage = new BN(14854);
                const reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);
                const token1Amount = reserve1Balance.mul(percentage).div(supply);
                const token2Amount = reserve2Balance.mul(percentage).div(supply);
                const token3Amount = reserve3Balance.mul(percentage).div(supply);

                const token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2PrevBalance = await reserveToken2.balanceOf.call(sender2);
                const token3PrevBalance = await reserveToken3.balanceOf.call(sender2);
                const res = await converter.liquidate(14854, { from: sender2 });

                let transactionCost = new BN(0);
                if (isETHReserve) {
                    transactionCost = await getTransactionCost(res);
                }

                const token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2Balance = await reserveToken2.balanceOf.call(sender2);
                const token3Balance = await reserveToken3.balanceOf.call(sender2);

                expect(token1Balance).to.be.bignumber.equal(token1PrevBalance.add(token1Amount.sub(transactionCost)));
                expect(token2Balance).to.be.bignumber.equal(token2PrevBalance.add(token2Amount));
                expect(token3Balance).to.be.bignumber.equal(token3PrevBalance.add(token3Amount));
            });

            it('verifies that liquidating the entire supply sends the full reserve balances to the caller', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(sender2, 20000);

                const reserve1Balance = await converter.reserveBalance.call(getReserve1Address(isETHReserve));
                const reserve2Balance = await converter.reserveBalance.call(reserveToken2.address);
                const reserve3Balance = await converter.reserveBalance.call(reserveToken3.address);

                const token1PrevBalance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2PrevBalance = await reserveToken2.balanceOf.call(sender2);
                const token3PrevBalance = await reserveToken3.balanceOf.call(sender2);
                const res = await converter.liquidate(20000, { from: sender2 });

                let transactionCost = new BN(0);
                if (isETHReserve) {
                    transactionCost = await getTransactionCost(res);
                }

                const supply = await token.totalSupply.call();
                const token1Balance = await getBalance(reserveToken, getReserve1Address(isETHReserve), sender2);
                const token2Balance = await reserveToken2.balanceOf.call(sender2);
                const token3Balance = await reserveToken3.balanceOf.call(sender2);

                expect(supply).to.be.bignumber.equal(new BN(0));
                expect(token1PrevBalance.add(reserve1Balance).sub(transactionCost)).to.be.bignumber.equal(token1Balance);
                expect(token2PrevBalance.add(reserve2Balance)).to.be.bignumber.equal(token2Balance);
                expect(token3PrevBalance.add(reserve3Balance)).to.be.bignumber.equal(token3Balance);
            });

            it('should revert when attempting to liquidate with insufficient funds', async () => {
                const converter = await initConverter(false, isETHReserve);
                await converter.addReserve(reserveToken3.address, 600000);

                await reserveToken3.transfer(converter.address, 6000);

                await token.transferOwnership(converter.address);
                await converter.acceptTokenOwnership();

                await token.transfer(sender2, 100);

                await converter.liquidate(5, { from: sender2 });

                await expectRevert.unspecified(converter.liquidate(600, { from: sender2 }));
            });
        });
    }

    describe('verifies that the maximum possible liquidity is added', () => {
        let converter;
        let reserveToken1;
        let reserveToken2;

        const amounts = [
            [1000, 1200],
            [200, 240],
            [2000, 2400],
            [20000, 22000],
            [20000, 26000],
            [100000, 120000]
        ];

        beforeEach(async () => {
            const token = await SmartToken.new('Token', 'TKN', 0);
            converter = await LiquidityPoolV1Converter.new(token.address, contractRegistry.address, 0);
            reserveToken1 = await ERC20Token.new('ERC Token 1', 'ERC1', 0, 1000000000);
            reserveToken2 = await ERC20Token.new('ERC Token 2', 'ERC2', 0, 1000000000);
            await converter.addReserve(reserveToken1.address, 500000);
            await converter.addReserve(reserveToken2.address, 500000);
            await token.transferOwnership(converter.address);
            await converter.acceptTokenOwnership();
        });

        for (const [amount1, amount2] of amounts) {
            it(`addLiquidity(${[amount1, amount2]})`, async () => {
                await reserveToken1.approve(converter.address, amount1, { from: sender });
                await reserveToken2.approve(converter.address, amount2, { from: sender });
                await converter.addLiquidity([reserveToken1.address, reserveToken2.address], [amount1, amount2], 1);
                const balance1 = await reserveToken1.balanceOf.call(converter.address);
                const balance2 = await reserveToken2.balanceOf.call(converter.address);
                const a1b2 = new BN(amount1).mul(balance2);
                const a2b1 = new BN(amount2).mul(balance1);
                const expected1 = a1b2.lt(a2b1) ? new BN(0) : a1b2.sub(a2b1).div(balance2);
                const expected2 = a2b1.lt(a1b2) ? new BN(0) : a2b1.sub(a1b2).div(balance1);
                const actual1 = await reserveToken1.allowance.call(sender, converter.address);
                const actual2 = await reserveToken2.allowance.call(sender, converter.address);
                expect(actual1).to.be.bignumber.equal(expected1);
                expect(actual2).to.be.bignumber.equal(expected2);
            });
        }
    });

    describe('verifies no gain by adding/removing liquidity', () => {
        const addAmounts = [
            [1000, 1000],
            [1000, 2000],
            [2000, 1000]
        ];

        const removePercents = [
            [100],
            [50, 50],
            [25, 75],
            [75, 25],
            [10, 20, 30, 40]
        ];

        for (const amounts of addAmounts) {
            for (const percents of removePercents) {
                it(`(amounts = ${amounts}, percents = ${percents})`, async () => {
                    const token = await SmartToken.new('Token', 'TKN', 0);
                    const converter = await LiquidityPoolV1Converter.new(token.address, contractRegistry.address, 0);
                    const reserveToken1 = await ERC20Token.new('ERC Token 1', 'ERC1', 0, 1000000000);
                    const reserveToken2 = await ERC20Token.new('ERC Token 2', 'ERC2', 0, 1000000000);
                    await converter.addReserve(reserveToken1.address, 500000);
                    await converter.addReserve(reserveToken2.address, 500000);
                    await token.transferOwnership(converter.address);
                    await converter.acceptTokenOwnership();
                    let lastAmount = new BN(0);
                    for (const amount of amounts) {
                        await reserveToken1.transfer(sender2, amount, { from: sender });
                        await reserveToken2.transfer(sender2, amount, { from: sender });
                        await reserveToken1.approve(converter.address, amount, { from: sender2 });
                        await reserveToken2.approve(converter.address, amount, { from: sender2 });
                        await converter.addLiquidity([reserveToken1.address, reserveToken2.address], [amount, amount], MIN_RETURN, { from: sender2 });
                        const balance = await token.balanceOf.call(sender2);
                        lastAmount = balance.sub(lastAmount);
                    }
                    for (const percent of percents) {
                        await converter.removeLiquidity(lastAmount.mul(new BN(percent)).div(new BN(100)),
                            [reserveToken1.address, reserveToken2.address], [MIN_RETURN, MIN_RETURN], { from: sender2 });
                    }
                    const balance1 = await reserveToken1.balanceOf.call(sender2);
                    const balance2 = await reserveToken2.balanceOf.call(sender2);
                    const amount = new BN(amounts[1]);
                    expect(balance1).to.be.bignumber.equal(amount);
                    expect(balance2).to.be.bignumber.equal(amount);
                });
            }
        }
    });
});
