const { expect } = require('chai');
const { expectRevert, expectEvent, BN, constants, time, balance } = require('@openzeppelin/test-helpers');
const { ETH_RESERVE_ADDRESS, registry } = require('./helpers/Constants');
const Decimal = require('decimal.js');

const { ZERO_ADDRESS } = constants;
const { duration, latest } = time;

const ContractRegistry = artifacts.require('ContractRegistry');
const BancorFormula = artifacts.require('BancorFormula');
const BancorNetwork = artifacts.require('BancorNetwork');
const DSToken = artifacts.require('DSToken');
const ConverterRegistry = artifacts.require('ConverterRegistry');
const ConverterRegistryData = artifacts.require('ConverterRegistryData');
const ConverterFactory = artifacts.require('ConverterFactory');
const LiquidityPoolV1ConverterFactory = artifacts.require('TestLiquidityPoolV1ConverterFactory');
const LiquidityPoolV1Converter = artifacts.require('TestLiquidityPoolV1Converter');
const LiquidityProtection = artifacts.require('TestLiquidityProtection');
const LiquidityProtectionStore = artifacts.require('LiquidityProtectionStore');

const PPM_RESOLUTION = new BN(1000000);

const RESERVE1_AMOUNT = new BN(1000000);
const RESERVE2_AMOUNT = new BN(2500000);

const PROTECTION_NO_PROTECTION = 0;
const PROTECTION_PARTIAL_PROTECTION = 1;
const PROTECTION_FULL_PROTECTION = 2;
const PROTECTION_EXCESSIVE_PROTECTION = 3;

contract('LiquidityProtection', (accounts) => {
    const initPool = async (isETH = false, whitelist = true, standard = true) => {
        if (isETH) {
            baseTokenAddress = ETH_RESERVE_ADDRESS;
        } else {
            // create a pool with ERC20 as the base token
            baseToken = await DSToken.new('RSV1', 'RSV1', 18);
            await baseToken.issue(owner, 1000000000);
            baseTokenAddress = baseToken.address;
        }

        let weights = [500000, 500000];
        if (!standard) {
            weights = [450000, 550000];
        }

        await converterRegistry.newConverter(
            1,
            'PT',
            'PT',
            18,
            PPM_RESOLUTION,
            [baseTokenAddress, networkToken.address],
            weights
        );
        const anchorCount = await converterRegistry.getAnchorCount.call();
        const poolTokenAddress = await converterRegistry.getAnchor.call(anchorCount - 1);
        poolToken = await DSToken.at(poolTokenAddress);
        converterAddress = await poolToken.owner.call();
        converter = await LiquidityPoolV1Converter.at(converterAddress);
        await converter.setTime(now);
        await converter.acceptOwnership();
        await networkToken.approve(converter.address, RESERVE2_AMOUNT);

        let value = 0;
        if (isETH) {
            value = RESERVE1_AMOUNT;
        } else {
            await baseToken.approve(converter.address, RESERVE1_AMOUNT);
        }

        await converter.addLiquidity([baseTokenAddress, networkToken.address], [RESERVE1_AMOUNT, RESERVE2_AMOUNT], 1, {
            value
        });

        // whitelist pool
        if (whitelist) {
            await liquidityProtection.whitelistPool(poolToken.address, true);
        }
    };

    const addProtectedLiquidity = async (
        poolTokenAddress,
        token,
        tokenAddress,
        amount,
        isETH = false,
        account = owner
    ) => {
        let value = 0;
        if (isETH) {
            value = amount;
        } else {
            await token.approve(liquidityProtection.address, amount, { from: account });
        }

        await liquidityProtection.addLiquidity(poolTokenAddress, tokenAddress, amount, { from: account, value });
    };

    const getProtection = (protection) => {
        return {
            provider: protection[0],
            poolToken: protection[1],
            reserveToken: protection[2],
            poolAmount: protection[3],
            reserveAmount: protection[4],
            reserveRateN: protection[5],
            reserveRateD: protection[6],
            timestamp: protection[7]
        };
    };

    const getTimestamp = async (protectionLevel) => {
        switch (protectionLevel) {
            case PROTECTION_NO_PROTECTION:
                return now.add(duration.days(15));
            case PROTECTION_PARTIAL_PROTECTION:
                return now.add(duration.days(40));
            case PROTECTION_FULL_PROTECTION:
                return now.add(duration.days(100));
            case PROTECTION_EXCESSIVE_PROTECTION:
                return now.add(duration.days(300));
        }
    };

    const poolTokenRate = (poolSupply, reserveBalance) => {
        return { n: reserveBalance.mul(new BN('2')), d: poolSupply };
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

    const expectAlmostEqual = (amount1, amount2, maxError = '0.01') => {
        if (!amount1.eq(amount2)) {
            const error = Decimal(amount1.toString()).div(amount2.toString()).sub(1).abs();
            expect(error.lte(maxError)).to.be.true(`error = ${error.toFixed(maxError.length)}`);
        }
    };

    const convert = async (path, amount, minReturn) => {
        let token;
        if (path[0] == baseTokenAddress) {
            token = baseToken;
        } else {
            token = networkToken;
        }

        await token.approve(bancorNetwork.address, amount);
        return bancorNetwork.convertByPath(path, amount, minReturn, ZERO_ADDRESS, ZERO_ADDRESS, 0);
    };

    const generateFee = async () => {
        await converter.setConversionFee(10000);

        // convert back & forth
        const prevBalance = await networkToken.balanceOf(owner);

        let amount = RESERVE1_AMOUNT.div(new BN(2));
        await convert([baseTokenAddress, poolToken.address, networkToken.address], amount, 1);

        const balance = await networkToken.balanceOf(owner);

        amount = balance.sub(prevBalance);
        await convert([networkToken.address, poolToken.address, baseTokenAddress], amount, 1);

        await converter.setConversionFee(0);
    };

    const getRate = async (reserveAddress) => {
        const reserve1Balance = await converter.reserveBalance(baseTokenAddress);
        const reserve2Balance = await converter.reserveBalance(networkToken.address);
        if (reserveAddress == baseTokenAddress) {
            return { n: reserve2Balance, d: reserve1Balance };
        }

        return { n: reserve1Balance, d: reserve2Balance };
    };

    const increaseRate = async (reserveAddress) => {
        let sourceAddress;
        if (reserveAddress == baseTokenAddress) {
            sourceAddress = networkToken.address;
        } else {
            sourceAddress = baseTokenAddress;
        }

        let path = [sourceAddress, poolToken.address, reserveAddress];
        let amount = await converter.reserveBalance(networkToken.address);
        amount = Decimal(2).sqrt().sub(1).mul(amount.toString());
        amount = new BN(amount.floor().toFixed());

        await convert(path, amount, 1);
    };

    const getLockedBalance = async (account) => {
        let lockedBalance = new BN(0);
        const lockedCount = await liquidityProtectionStore.lockedBalanceCount(account);
        for (let i = 0; i < lockedCount; i++) {
            const balance = (await liquidityProtectionStore.lockedBalance(account, i))[0];
            lockedBalance = lockedBalance.add(balance);
        }

        return lockedBalance;
    };

    let now;
    let contractRegistry;
    let bancorNetwork;
    let networkToken;
    let govToken;
    let poolToken;
    let converterRegistry;
    let converter;
    let liquidityProtectionStore;
    let liquidityProtection;
    let baseToken;
    let baseTokenAddress;

    const owner = accounts[0];

    before(async () => {
        contractRegistry = await ContractRegistry.new();
        converterRegistry = await ConverterRegistry.new(contractRegistry.address);
        converterRegistryData = await ConverterRegistryData.new(contractRegistry.address);
        bancorNetwork = await BancorNetwork.new(contractRegistry.address);

        const liquidityPoolV1ConverterFactory = await LiquidityPoolV1ConverterFactory.new();
        converterFactory = await ConverterFactory.new();
        await converterFactory.registerTypedConverterFactory(liquidityPoolV1ConverterFactory.address);

        const bancorFormula = await BancorFormula.new();
        await bancorFormula.init();

        await contractRegistry.registerAddress(registry.CONVERTER_FACTORY, converterFactory.address);
        await contractRegistry.registerAddress(registry.CONVERTER_REGISTRY, converterRegistry.address);
        await contractRegistry.registerAddress(registry.CONVERTER_REGISTRY_DATA, converterRegistryData.address);
        await contractRegistry.registerAddress(registry.BANCOR_FORMULA, bancorFormula.address);
        await contractRegistry.registerAddress(registry.BANCOR_NETWORK, bancorNetwork.address);
    });

    beforeEach(async () => {
        networkToken = await DSToken.new('BNT', 'BNT', 18);
        govToken = await DSToken.new('vBNT', 'vBNT', 18);
        await networkToken.issue(owner, 1000000000);

        // initialize liquidity protection
        liquidityProtectionStore = await LiquidityProtectionStore.new(contractRegistry.address);
        liquidityProtection = await LiquidityProtection.new(
            liquidityProtectionStore.address,
            networkToken.address,
            govToken.address,
            contractRegistry.address
        );
        await liquidityProtectionStore.transferOwnership(liquidityProtection.address);
        await networkToken.transferOwnership(liquidityProtection.address);
        await govToken.transferOwnership(liquidityProtection.address);
        await liquidityProtection.acceptStoreOwnership();
        await liquidityProtection.acceptNetworkTokenOwnership();
        await liquidityProtection.acceptGovTokenOwnership();

        now = await latest();
        await liquidityProtection.setTime(now);

        // initialize pool
        await initPool();
    });

    it('verifies the liquidity protection contract after initialization', async () => {
        const whitelistAdmin = await liquidityProtection.whitelistAdmin.call();
        expect(whitelistAdmin).to.eql(owner);

        const store = await liquidityProtection.store.call();
        expect(store).to.eql(liquidityProtectionStore.address);

        const networkTkn = await liquidityProtection.networkToken.call();
        expect(networkTkn).to.eql(networkToken.address);

        const govTkn = await liquidityProtection.govToken.call();
        expect(govTkn).to.eql(govToken.address);
    });

    it('verifies that the owner can transfer the store ownership', async () => {
        await liquidityProtection.transferStoreOwnership(accounts[1]);
        liquidityProtectionStore.acceptOwnership({ from: accounts[1] });
    });

    it('should revert when a non owner attempts to transfer the store ownership', async () => {
        await expectRevert(
            liquidityProtection.transferStoreOwnership(accounts[2], { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('verifies that the owner can transfer the network token ownership', async () => {
        await liquidityProtection.transferNetworkTokenOwnership(accounts[1]);
        networkToken.acceptOwnership({ from: accounts[1] });
    });

    it('should revert when a non owner attempts to transfer the network token ownership', async () => {
        await expectRevert(
            liquidityProtection.transferNetworkTokenOwnership(accounts[2], { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('verifies that the owner can transfer the governance token ownership', async () => {
        await liquidityProtection.transferGovTokenOwnership(accounts[1]);
        govToken.acceptOwnership({ from: accounts[1] });
    });

    it('should revert when a non owner attempts to transfer the governance token ownership', async () => {
        await expectRevert(
            liquidityProtection.transferGovTokenOwnership(accounts[2], { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('verifies that the owner can set the system network token limits', async () => {
        const prevMaxSystemNetworkTokenAmount = await liquidityProtection.maxSystemNetworkTokenAmount.call();
        const prevMaxSystemNetworkTokenRatio = await liquidityProtection.maxSystemNetworkTokenRatio.call();
        const newMaxSystemNetworkTokenAmount = new BN(100);
        const newMaxSystemNetworkTokenRatio = new BN(200);

        const res = await liquidityProtection.setSystemNetworkTokenLimits(
            newMaxSystemNetworkTokenAmount,
            newMaxSystemNetworkTokenRatio
        );

        expectEvent(res, 'SystemNetworkTokenLimitsUpdated', {
            _prevMaxSystemNetworkTokenAmount: prevMaxSystemNetworkTokenAmount,
            _newMaxSystemNetworkTokenAmount: newMaxSystemNetworkTokenAmount,
            _prevMaxSystemNetworkTokenRatio: prevMaxSystemNetworkTokenRatio,
            _newMaxSystemNetworkTokenRatio: newMaxSystemNetworkTokenRatio
        });

        const maxSystemNetworkTokenAmount = await liquidityProtection.maxSystemNetworkTokenAmount.call();
        const maxSystemNetworkTokenRatio = await liquidityProtection.maxSystemNetworkTokenRatio.call();

        expect(maxSystemNetworkTokenAmount).not.to.be.bignumber.equal(prevMaxSystemNetworkTokenAmount);
        expect(maxSystemNetworkTokenRatio).not.to.be.bignumber.equal(prevMaxSystemNetworkTokenRatio);

        expect(maxSystemNetworkTokenAmount).to.be.bignumber.equal(newMaxSystemNetworkTokenAmount);
        expect(maxSystemNetworkTokenRatio).to.be.bignumber.equal(newMaxSystemNetworkTokenRatio);
    });

    it('should revert when a non owner attempts to set the system network token limits', async () => {
        await expectRevert(
            liquidityProtection.setSystemNetworkTokenLimits(100, 200, { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('should revert when the owner attempts to set a system network token ratio that is larger than 100%', async () => {
        await expectRevert(
            liquidityProtection.setSystemNetworkTokenLimits(200, PPM_RESOLUTION.add(new BN(1))),
            'ERR_INVALID_PORTION'
        );
    });

    it('verifies that the owner can set the protection delays', async () => {
        const prevMinProtectionDelay = await liquidityProtection.minProtectionDelay.call();
        const prevMaxProtectionDelay = await liquidityProtection.maxProtectionDelay.call();
        const newMinProtectionDelay = new BN(100);
        const newMaxProtectionDelay = new BN(200);

        const res = await liquidityProtection.setProtectionDelays(newMinProtectionDelay, 200);

        expectEvent(res, 'ProtectionDelaysUpdated', {
            _prevMinProtectionDelay: prevMinProtectionDelay,
            _newMinProtectionDelay: newMinProtectionDelay,
            _prevMaxProtectionDelay: prevMaxProtectionDelay,
            _newMaxProtectionDelay: newMaxProtectionDelay
        });

        const minProtectionDelay = await liquidityProtection.minProtectionDelay.call();
        const maxProtectionDelay = await liquidityProtection.maxProtectionDelay.call();

        expect(minProtectionDelay).not.to.be.bignumber.equal(prevMinProtectionDelay);
        expect(maxProtectionDelay).not.to.be.bignumber.equal(prevMaxProtectionDelay);

        expect(minProtectionDelay).to.be.bignumber.equal(newMinProtectionDelay);
        expect(maxProtectionDelay).to.be.bignumber.equal(newMaxProtectionDelay);
    });

    it('should revert when a non owner attempts to set the protection delays', async () => {
        await expectRevert(
            liquidityProtection.setProtectionDelays(100, 200, { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('should revert when the owner attempts to set a minimum protection delay that is larger than the maximum delay', async () => {
        await expectRevert(liquidityProtection.setProtectionDelays(200, 100), 'ERR_INVALID_PROTECTION_DELAY');
    });

    it('verifies that the owner can set the minimum network compenstation', async () => {
        const prevMinNetworkCompensation = await liquidityProtection.minNetworkCompensation.call();
        const newMinNetworkCompensation = new BN(100);

        const res = await liquidityProtection.setMinNetworkCompensation(newMinNetworkCompensation);

        expectEvent(res, 'MinNetworkCompensationUpdated', {
            _prevMinNetworkCompensation: prevMinNetworkCompensation,
            _newMinNetworkCompensation: newMinNetworkCompensation
        });

        const minNetworkCompensation = await liquidityProtection.minNetworkCompensation.call();

        expect(minNetworkCompensation).not.to.be.bignumber.equal(prevMinNetworkCompensation);
        expect(minNetworkCompensation).to.be.bignumber.equal(newMinNetworkCompensation);
    });

    it('should revert when a non owner attempts to set the minimum network compensation', async () => {
        await expectRevert(
            liquidityProtection.setMinNetworkCompensation(100, { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('verifies that the owner can set the lock duration', async () => {
        const prevLockDuration = await liquidityProtection.lockDuration.call();
        const newLockDuration = new BN(100);

        const res = await liquidityProtection.setLockDuration(newLockDuration);
        expectEvent(res, 'LockDurationUpdated', {
            _prevLockDuration: prevLockDuration,
            _newLockDuration: newLockDuration
        });

        const lockDuration = await liquidityProtection.lockDuration.call();

        expect(lockDuration).not.to.be.bignumber.equal(prevLockDuration);
        expect(lockDuration).to.be.bignumber.equal(new BN(100));
    });

    it('should revert when a non owner attempts to set the lock duration', async () => {
        await expectRevert(liquidityProtection.setLockDuration('100', { from: accounts[1] }), 'ERR_ACCESS_DENIED');
    });

    it('verifies that the owner can set the maximum deviation of the average rate from the actual rate', async () => {
        expect(await liquidityProtection.averageRateMaxDeviation.call()).to.be.bignumber.equal('5000');

        const res = await liquidityProtection.setAverageRateMaxDeviation('30000');
        expectEvent(res, 'AverageRateMaxDeviationUpdated', {
            _prevAverageRateMaxDeviation: '5000',
            _newAverageRateMaxDeviation: '30000'
        });

        expect(await liquidityProtection.averageRateMaxDeviation.call()).to.be.bignumber.equal('30000');
    });

    it('should revert when a non owner attempts to set the maximum deviation of the average rate from the actual rate', async () => {
        await expectRevert(
            liquidityProtection.setAverageRateMaxDeviation('30000', { from: accounts[1] }),
            'ERR_INVALID_PORTION'
        );
    });

    describe('whitelist', () => {
        it('verifies that the owner can update the whitelist admin', async () => {
            const newWhitelistAdmin = accounts[3];

            expect(await liquidityProtection.whitelistAdmin.call()).not.to.be.eql(newWhitelistAdmin);

            const res = await liquidityProtection.setWhitelistAdmin(newWhitelistAdmin);
            expectEvent(res, 'WhitelistAdminUpdated', {
                _prevWhitelistAdmin: owner,
                _newWhitelistAdmin: newWhitelistAdmin
            });

            expect(await liquidityProtection.whitelistAdmin.call()).to.be.eql(newWhitelistAdmin);
        });

        it('should revert when trying to set the whitelist admin to a zero address', async () => {
            await expectRevert(liquidityProtection.setWhitelistAdmin(ZERO_ADDRESS), 'ERR_INVALID_ADDRESS');
        });

        it('should revert when a non owner tries to update the whitelist admin', async () => {
            const newWhitelistAdmin = accounts[3];

            await expectRevert(
                liquidityProtection.setWhitelistAdmin(newWhitelistAdmin, { from: accounts[1] }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when attempting to add a non standard pool to the whitelist', async () => {
            await initPool(false, false, false);

            await expectRevert(liquidityProtection.whitelistPool(poolToken.address, true), 'ERR_POOL_NOT_SUPPORTED');
        });

        context('with a non-default whitelist admin', async () => {
            const whitelistAdmin = accounts[4];

            beforeEach(async () => {
                await liquidityProtection.setWhitelistAdmin(whitelistAdmin);
            });

            it('verifies that the whitelist admin can add a pool to the whitelist', async () => {
                await initPool(false, false);

                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.false;

                await liquidityProtection.whitelistPool(poolToken.address, true, { from: whitelistAdmin });

                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.true;
            });

            it('verifies that the whitelist admin can remove a pool from the whitelist', async () => {
                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.true;

                await liquidityProtection.whitelistPool(poolToken.address, false, { from: whitelistAdmin });

                expect(await liquidityProtectionStore.isPoolWhitelisted(poolToken.address)).to.be.false;
            });

            it('verifies that the owner can add a pool to the whitelist', async () => {
                await initPool(false, false);

                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.false;

                await liquidityProtection.whitelistPool(poolToken.address, true, { from: owner });

                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.true;
            });

            it('verifies that the owner can remove a pool from the whitelist', async () => {
                expect(await liquidityProtectionStore.isPoolWhitelisted.call(poolToken.address)).to.be.true;

                await liquidityProtection.whitelistPool(poolToken.address, false, { from: owner });

                expect(await liquidityProtectionStore.isPoolWhitelisted(poolToken.address)).to.be.false;
            });

            it('should revert when a non owner or a non whitelist admin attempts add a pool to the whitelist', async () => {
                await initPool(false, false);

                await expectRevert(
                    liquidityProtection.whitelistPool(poolToken.address, true, { from: accounts[1] }),
                    'ERR_ACCESS_DENIED'
                );
            });
        });
    });

    it('verifies that isPoolSupported returns true for a standard pool', async () => {
        const isSupported = await liquidityProtection.isPoolSupported.call(poolToken.address);
        expect(isSupported).to.be.true;
    });

    it('should revert when calling isPoolSupported with an address that is not an anchor in the registry', async () => {
        await expectRevert(liquidityProtection.isPoolSupported(accounts[2]), 'ERR_INVALID_ANCHOR');
    });

    it('verifies that isPoolSupported returns false for a pool with 3 reserves', async () => {
        const reserveToken = await DSToken.new('RSV1', 'RSV1', 18);
        await converterRegistry.newConverter(
            1,
            'PT',
            'PT',
            18,
            5000,
            [ETH_RESERVE_ADDRESS, networkToken.address, reserveToken.address],
            [100000, 100000, 100000]
        );
        const anchorCount = await converterRegistry.getAnchorCount.call();
        const poolTokenAddress = await converterRegistry.getAnchor.call(anchorCount - 1);

        const isSupported = await liquidityProtection.isPoolSupported.call(poolTokenAddress);
        expect(isSupported).to.be.false;
    });

    it('verifies that isPoolSupported returns false for a pool that does not have the network token as reserve', async () => {
        const reserveToken = await DSToken.new('RSV1', 'RSV1', 18);
        await converterRegistry.newConverter(
            1,
            'PT',
            'PT',
            18,
            5000,
            [ETH_RESERVE_ADDRESS, reserveToken.address],
            [500000, 500000]
        );
        const anchorCount = await converterRegistry.getAnchorCount.call();
        const poolTokenAddress = await converterRegistry.getAnchor.call(anchorCount - 1);

        const isSupported = await liquidityProtection.isPoolSupported.call(poolTokenAddress);
        expect(isSupported).to.be.false;
    });

    it('verifies that isPoolSupported returns false for a pool with reserve weights that are not 50%/50%', async () => {
        await converterRegistry.newConverter(
            1,
            'PT',
            'PT',
            18,
            5000,
            [ETH_RESERVE_ADDRESS, networkToken.address],
            [450000, 550000]
        );
        const anchorCount = await converterRegistry.getAnchorCount.call();
        const poolTokenAddress = await converterRegistry.getAnchor.call(anchorCount - 1);

        const isSupported = await liquidityProtection.isPoolSupported.call(poolTokenAddress);
        expect(isSupported).to.be.false;
    });

    it('verifies that the caller can protect pool tokens', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        expect(protectionIds.length).to.eql(2);

        let protection1 = await liquidityProtectionStore.protectedLiquidity.call(protectionIds[0]);
        protection1 = getProtection(protection1);
        expect(protection1.poolToken).to.eql(poolToken.address);
        expect(protection1.reserveToken).to.eql(baseTokenAddress);
        expect(protection1.poolAmount).to.be.bignumber.equal(balance.div(new BN(2)));
        expect(protection1.reserveAmount).to.be.bignumber.equal(RESERVE1_AMOUNT);
        expect(protection1.reserveRateN).to.be.bignumber.equal(RESERVE2_AMOUNT);
        expect(protection1.reserveRateD).to.be.bignumber.equal(RESERVE1_AMOUNT);
        expect(protection1.timestamp).to.be.bignumber.equal(new BN(now));

        let protection2 = await liquidityProtectionStore.protectedLiquidity.call(protectionIds[1]);
        protection2 = getProtection(protection2);
        expect(protection2.poolToken).to.eql(poolToken.address);
        expect(protection2.reserveToken).to.eql(networkToken.address);
        expect(protection2.poolAmount).to.be.bignumber.equal(balance.sub(balance.div(new BN(2))));
        expect(protection2.reserveAmount).to.be.bignumber.equal(RESERVE2_AMOUNT);
        expect(protection2.reserveRateN).to.be.bignumber.equal(RESERVE1_AMOUNT);
        expect(protection2.reserveRateD).to.be.bignumber.equal(RESERVE2_AMOUNT);
        expect(protection2.timestamp).to.be.bignumber.equal(new BN(now));

        const newBalance = await poolToken.balanceOf.call(owner);
        expect(newBalance).to.be.bignumber.equal(new BN(0));

        const storeBalance = await poolToken.balanceOf.call(liquidityProtectionStore.address);
        expect(storeBalance).to.be.bignumber.equal(balance);

        const govBalance = await govToken.balanceOf.call(owner);
        expect(govBalance).to.be.bignumber.equal(RESERVE2_AMOUNT);
    });

    it('should revert when attempting to protect pool tokens for an unsupported pool', async () => {
        await initPool(false, false, false);

        await expectRevert(liquidityProtection.protectLiquidity(poolToken.address, '100'), 'ERR_POOL_NOT_SUPPORTED');
    });

    it('should revert when attempting to protect pool tokens for a non whitelisted pool', async () => {
        await initPool(false, false, true);

        await expectRevert(liquidityProtection.protectLiquidity(poolToken.address, '100'), 'ERR_POOL_NOT_WHITELISTED');
    });

    it('should revert when attempting to protect 0 pool tokens', async () => {
        await expectRevert(liquidityProtection.protectLiquidity(poolToken.address, 0), 'ERR_ZERO_VALUE');
    });

    it('verifies that the caller can unprotect pool tokens', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[1]);
        protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        expect(protectionIds.length).to.eql(0);

        const newBalance = await poolToken.balanceOf.call(owner);
        expect(newBalance).to.be.bignumber.equal(balance);

        const storeBalance = await poolToken.balanceOf.call(liquidityProtectionStore.address);
        expect(storeBalance).to.be.bignumber.equal(new BN(0));

        const govBalance = await govToken.balanceOf.call(owner);
        expect(govBalance).to.be.bignumber.equal(new BN(0));
    });

    it('should revert when attempting to unprotect pool tokens with a first id that does not exist', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(liquidityProtection.unprotectLiquidity('1234', protectionIds[1]), 'ERR_ACCESS_DENIED');
    });

    it('should revert when attempting to unprotect pool tokens with a second id that does not exist', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(liquidityProtection.unprotectLiquidity(protectionIds[0], '1234'), 'ERR_ACCESS_DENIED');
    });

    it('should revert when attempting to unprotect pool tokens with the same protection id', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[0]), 'ERR_SAME_ID');
    });

    it('should revert when attempting to unprotect pool tokens owned by another account', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[1], { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('should revert when attempting to unprotect pool tokens with ids that point to different pools', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);
        await liquidityProtection.protectLiquidity(poolToken.address, balance);

        await initPool();

        const balance2 = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance2);
        await liquidityProtection.protectLiquidity(poolToken.address, balance2);

        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[2]),
            'ERR_PROTECTIONS_MISMATCH'
        );
    });

    it('should revert when attempting to unprotect pool tokens with ids that point to protections with the same reserve', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);
        await liquidityProtection.protectLiquidity(poolToken.address, '200');
        await liquidityProtection.protectLiquidity(poolToken.address, '200');

        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[2]),
            'ERR_PROTECTIONS_MISMATCH'
        );
    });

    it('should revert when attempting to unprotect pool tokens with ids that point to protections with different pool token amounts', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);
        await liquidityProtection.protectLiquidity(poolToken.address, '50');
        await liquidityProtection.protectLiquidity(poolToken.address, '200');

        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[3]),
            'ERR_PROTECTIONS_MISMATCH'
        );
    });

    it('should revert when attempting to unprotect pool tokens with ids that point to protections with different timestamps', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);
        await liquidityProtection.protectLiquidity(poolToken.address, '200');

        liquidityProtection.setTime(now.add(duration.seconds(1)));
        await liquidityProtection.protectLiquidity(poolToken.address, '200');

        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[3]),
            'ERR_PROTECTIONS_MISMATCH'
        );
    });

    it('should revert when attempting to unprotect pool tokens while the caller does not hold enough governance tokens', async () => {
        const balance = await poolToken.balanceOf.call(owner);
        await poolToken.approve(liquidityProtection.address, balance);

        await liquidityProtection.protectLiquidity(poolToken.address, balance);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        const govBalance = await govToken.balanceOf.call(owner);
        await govToken.transfer(accounts[1], govBalance);

        await expectRevert(liquidityProtection.unprotectLiquidity(protectionIds[0], protectionIds[1]), 'ERR_UNDERFLOW');
    });

    for (let isETHReserve = 0; isETHReserve < 2; isETHReserve++) {
        describe(`base token (${isETHReserve ? 'ETH' : 'ERC20'})`, () => {
            beforeEach(async () => {
                await initPool(isETHReserve);
            });

            it('verifies that the caller can add liquidity', async () => {
                const totalSupply = await poolToken.totalSupply.call();
                const reserveBalance = await converter.reserveBalance.call(baseTokenAddress);
                const rate = poolTokenRate(totalSupply, reserveBalance);

                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );

                // verify protection details
                const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                expect(protectionIds.length).to.eql(1);

                const expectedPoolAmount = reserveAmount.mul(rate.d).div(rate.n);
                const reserve1Balance = await converter.reserveBalance.call(baseTokenAddress);
                const reserve2Balance = await converter.reserveBalance.call(networkToken.address);

                let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionIds[0]);
                protection = getProtection(protection);
                expect(protection.poolToken).to.eql(poolToken.address);
                expect(protection.reserveToken).to.eql(baseTokenAddress);
                expect(protection.poolAmount).to.be.bignumber.equal(expectedPoolAmount);
                expect(protection.reserveAmount).to.be.bignumber.equal(reserveAmount);
                expect(protection.reserveRateN).to.be.bignumber.equal(reserve2Balance);
                expect(protection.reserveRateD).to.be.bignumber.equal(reserve1Balance);
                expect(protection.timestamp).to.be.bignumber.equal(new BN(now));

                // verify balances
                const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
                expect(systemBalance).to.be.bignumber.equal(expectedPoolAmount);

                const storeBalance = await poolToken.balanceOf.call(liquidityProtectionStore.address);
                expect(storeBalance).to.be.bignumber.equal(expectedPoolAmount.mul(new BN(2)));

                const govBalance = await govToken.balanceOf.call(owner);
                expect(govBalance).to.be.bignumber.equal(new BN(0));

                const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
                expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

                const protectionBaseBalance = await getBalance(
                    baseToken,
                    baseTokenAddress,
                    liquidityProtection.address
                );
                expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

                const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
                expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
            });

            it('verifies that the caller can add liquidity', async () => {
                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );
            });

            it('should revert when attempting to add liquidity with zero amount', async () => {
                const reserveAmount = new BN(0);
                await expectRevert(
                    addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, isETHReserve),
                    'ERR_ZERO_VALUE'
                );
            });

            it('should revert when attempting to add liquidity to an unsupported pool', async () => {
                await initPool(isETHReserve, false, false);

                const reserveAmount = new BN(1000);
                await expectRevert(
                    addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, isETHReserve),
                    'ERR_POOL_NOT_SUPPORTED'
                );
            });

            it('should revert when attempting to add liquidity to a non whitelisted pool', async () => {
                await liquidityProtection.whitelistPool(poolToken.address, false);

                const reserveAmount = new BN(1000);
                await expectRevert(
                    addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, isETHReserve),
                    'ERR_POOL_NOT_WHITELISTED'
                );
            });

            it('should revert when attempting to add liquidity with the wrong ETH value', async () => {
                const reserveAmount = new BN(1000);
                let value = 0;
                if (!isETHReserve) {
                    value = reserveAmount;
                    await baseToken.approve(liquidityProtection.address, reserveAmount);
                }

                await expectRevert(
                    liquidityProtection.addLiquidity(poolToken.address, baseTokenAddress, reserveAmount, { value }),
                    'ERR_ETH_AMOUNT_MISMATCH'
                );
            });

            it('should revert when attempting to add liquidity which will increase the system network token balance above the max amount', async () => {
                let reserveAmount = new BN(10000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );

                await liquidityProtection.setSystemNetworkTokenLimits(500, PPM_RESOLUTION);
                reserveAmount = new BN(2000);

                await expectRevert(
                    addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, isETHReserve),
                    'ERR_MAX_AMOUNT_REACHED'
                );
            });

            it('should revert when attempting to add liquidity which will increase the system network token balance above the max ratio', async () => {
                let reserveAmount = new BN(10000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );

                await liquidityProtection.setSystemNetworkTokenLimits(500000, 20000);
                reserveAmount = new BN(40000);

                await expectRevert(
                    addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, isETHReserve),
                    'ERR_MAX_RATIO_REACHED'
                );
            });
        });
    }

    describe('network token', () => {
        it('verifies that the caller can add liquidity', async () => {
            let reserveAmount = new BN(5000);
            await baseToken.transfer(accounts[1], 5000);
            await addProtectedLiquidity(
                poolToken.address,
                baseToken,
                baseTokenAddress,
                reserveAmount,
                false,
                accounts[1]
            );

            const totalSupply = await poolToken.totalSupply.call();
            const reserveBalance = await converter.reserveBalance.call(networkToken.address);
            const rate = poolTokenRate(totalSupply, reserveBalance);

            const prevBalance = await networkToken.balanceOf(owner);
            const prevSystemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            const prevStoreBalance = await poolToken.balanceOf.call(liquidityProtectionStore.address);

            reserveAmount = new BN(1000);
            await addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, reserveAmount);

            // verify protection details
            const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            expect(protectionIds.length).to.eql(1);

            const expectedPoolAmount = reserveAmount.mul(rate.d).div(rate.n);
            const reserve1Balance = await converter.reserveBalance.call(networkToken.address);
            const reserve2Balance = await converter.reserveBalance.call(baseTokenAddress);

            let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionIds[0]);
            protection = getProtection(protection);
            expect(protection.poolToken).to.eql(poolToken.address);
            expect(protection.reserveToken).to.eql(networkToken.address);
            expect(protection.poolAmount).to.be.bignumber.equal(expectedPoolAmount);
            expect(protection.reserveAmount).to.be.bignumber.equal(reserveAmount);
            expect(protection.reserveRateN).to.be.bignumber.equal(reserve2Balance);
            expect(protection.reserveRateD).to.be.bignumber.equal(reserve1Balance);
            expect(protection.timestamp).to.be.bignumber.equal(new BN(now));

            // verify balances
            const balance = await networkToken.balanceOf(owner);
            expect(balance).to.be.bignumber.equal(prevBalance.sub(reserveAmount));

            const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            expect(systemBalance).to.be.bignumber.equal(prevSystemBalance.sub(expectedPoolAmount));

            const storeBalance = await poolToken.balanceOf.call(liquidityProtectionStore.address);
            expect(storeBalance).to.be.bignumber.equal(prevStoreBalance);

            const govBalance = await govToken.balanceOf.call(owner);
            expect(govBalance).to.be.bignumber.equal(reserveAmount);

            const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
            expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

            const protectionBaseBalance = await getBalance(baseToken, baseTokenAddress, liquidityProtection.address);
            expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

            const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
            expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
        });

        it('should revert when attempting to add liquidity with zero amount', async () => {
            const reserveAmount = new BN(0);
            await expectRevert(
                addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount),
                'ERR_ZERO_VALUE'
            );
        });

        it('should revert when attempting to add liquidity to an unsupported pool', async () => {
            await initPool(false, false, false);

            const reserveAmount = new BN(1000);
            await expectRevert(
                addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount),
                'ERR_POOL_NOT_SUPPORTED'
            );
        });

        it('should revert when attempting to add liquidity to a non whitelisted pool', async () => {
            await liquidityProtection.whitelistPool(poolToken.address, false);

            const reserveAmount = new BN(1000);
            await expectRevert(
                addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount),
                'ERR_POOL_NOT_WHITELISTED'
            );
        });

        it('should revert when attempting to add liquidity with nonzero ETH value', async () => {
            const reserveAmount = new BN(1000);

            await expectRevert(
                liquidityProtection.addLiquidity(poolToken.address, baseTokenAddress, reserveAmount, {
                    value: reserveAmount
                }),
                'ERR_ETH_AMOUNT_MISMATCH'
            );
        });

        it('should revert when attempting to add more liquidity than the system currently owns', async () => {
            let reserveAmount = new BN(5000);
            await baseToken.transfer(accounts[1], 5000);
            await addProtectedLiquidity(
                poolToken.address,
                baseToken,
                baseTokenAddress,
                reserveAmount,
                false,
                accounts[1]
            );

            reserveAmount = new BN(100000);

            await expectRevert(
                addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, reserveAmount),
                'ERR_UNDERFLOW'
            );
        });
    });

    it('verifies that the caller can transfer liquidity to another account', async () => {
        let reserveAmount = new BN(5000);
        await baseToken.transfer(accounts[1], 5000);
        await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount, false, accounts[1]);

        reserveAmount = new BN(1000);
        await addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, reserveAmount);

        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        expect(protectionIds.length).to.eql(1);

        let protectionId = protectionIds[0];
        let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
        protection = getProtection(protection);

        await liquidityProtection.transferLiquidity(protectionId, accounts[2]);

        protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        expect(protectionIds.length).to.eql(0);

        let protectionIds2 = await liquidityProtectionStore.protectedLiquidityIds(accounts[2]);
        expect(protectionIds2.length).to.eql(1);

        let protection2 = await liquidityProtectionStore.protectedLiquidity.call(protectionIds2[0]);
        protection2 = getProtection(protection2);

        expect(protection.poolToken).to.eql(protection2.poolToken);
        expect(protection.reserveToken).to.eql(protection2.reserveToken);
        expect(protection.poolAmount).to.be.bignumber.equal(protection2.poolAmount);
        expect(protection.reserveAmount).to.be.bignumber.equal(protection2.reserveAmount);
        expect(protection.reserveRateN).to.be.bignumber.equal(protection2.reserveRateN);
        expect(protection.reserveRateD).to.be.bignumber.equal(protection2.reserveRateD);
        expect(protection.timestamp).to.be.bignumber.equal(protection2.timestamp);
    });

    it('should revert when attempting to transfer liquidity to a zero address', async () => {
        await expectRevert(liquidityProtection.transferLiquidity('0', ZERO_ADDRESS), 'ERR_INVALID_ADDRESS');
    });

    it('should revert when attempting to transfer liquidity to the liquidity protection contract', async () => {
        await expectRevert(
            liquidityProtection.transferLiquidity('0', liquidityProtection.address),
            'ERR_ADDRESS_IS_SELF'
        );
    });

    it('should revert when attempting to transfer liquidity that does not exist', async () => {
        await expectRevert(liquidityProtection.transferLiquidity('1234', accounts[3]), 'ERR_ACCESS_DENIED');
    });

    it('should revert when attempting to transfer liquidity that belongs to another account', async () => {
        let reserveAmount = new BN(5000);
        await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount);

        const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        const protectionId = protectionIds[0];

        await expectRevert(
            liquidityProtection.transferLiquidity(protectionId, accounts[2], { from: accounts[1] }),
            'ERR_ACCESS_DENIED'
        );
    });

    it('verifies that removeLiquidityReturn returns the correct amount for removing entire protection', async () => {
        const reserveAmount = new BN(1000);
        await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        const protectionId = protectionIds[0];
        let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
        protection = getProtection(protection);

        const amount = (await liquidityProtection.removeLiquidityReturn(protectionIds[0], PPM_RESOLUTION, now))[0];

        expect(amount).to.be.bignumber.equal(reserveAmount);
    });

    it('verifies that removeLiquidityReturn returns the correct amount for removing a portion of a protection', async () => {
        const reserveAmount = new BN(1000);
        await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
        const protectionId = protectionIds[0];
        let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
        protection = getProtection(protection);

        const amount = (await liquidityProtection.removeLiquidityReturn(protectionIds[0], 800000, now))[0];

        expect(amount).to.be.bignumber.equal(new BN(800));
    });

    it('should revert when calling removeLiquidityReturn with zero portion of the liquidity', async () => {
        await expectRevert(liquidityProtection.removeLiquidityReturn('1234', 0, now), 'ERR_INVALID_PERCENT');
    });

    it('should revert when calling removeLiquidityReturn with remove more than 100% of the liquidity', async () => {
        await expectRevert(
            liquidityProtection.removeLiquidityReturn('1234', PPM_RESOLUTION.add(new BN(1)), now),
            'ERR_INVALID_PERCENT'
        );
    });

    it('should revert when calling removeLiquidityReturn with a date earlier than the protection deposit', async () => {
        const reserveAmount = new BN(1000);
        await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, reserveAmount);
        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);

        await expectRevert(
            liquidityProtection.removeLiquidityReturn(protectionIds[0], PPM_RESOLUTION, now.sub(duration.years(1))),
            'ERR_INVALID_TIMESTAMP'
        );
    });

    it('should revert when calling removeLiquidityReturn with invalid id', async () => {
        await expectRevert(liquidityProtection.removeLiquidityReturn('1234', PPM_RESOLUTION, now), 'ERR_INVALID_ID');
    });

    for (let isETHReserve = 0; isETHReserve < 2; isETHReserve++) {
        describe(`base token (${isETHReserve ? 'ETH' : 'ERC20'})`, () => {
            beforeEach(async () => {
                await initPool(isETHReserve);
            });

            it('verifies that the caller can remove entire protection', async () => {
                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );
                let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];
                let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
                protection = getProtection(protection);

                const prevSystemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
                const prevStoreBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
                const prevBalance = await getBalance(baseToken, baseTokenAddress, owner);
                const prevGovBalance = await govToken.balanceOf(owner);

                const res = await liquidityProtection.removeLiquidity(protectionIds[0], PPM_RESOLUTION);
                protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                expect(protectionIds.length).to.eql(0);

                let transactionCost = new BN(0);
                if (isETHReserve) {
                    transactionCost = await getTransactionCost(res);
                }

                // verify balances
                const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
                expect(systemBalance).to.be.bignumber.equal(prevSystemBalance.sub(protection.poolAmount));

                const storeBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
                // double since system balance was also liquidated
                const delta = protection.poolAmount.mul(new BN(2));
                expect(storeBalance).to.be.bignumber.equal(prevStoreBalance.sub(delta));

                const balance = await getBalance(baseToken, baseTokenAddress, owner);
                expect(balance).to.be.bignumber.equal(prevBalance.add(reserveAmount).sub(transactionCost));

                const govBalance = await govToken.balanceOf.call(owner);
                expect(govBalance).to.be.bignumber.equal(prevGovBalance);

                const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
                expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

                const protectionBaseBalance = await getBalance(
                    baseToken,
                    baseTokenAddress,
                    liquidityProtection.address
                );
                expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

                const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
                expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
            });

            it('verifies that the caller can remove a portion of a protection', async () => {
                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );
                let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];
                let prevProtection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
                prevProtection = getProtection(prevProtection);

                const prevSystemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
                const prevStoreBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
                const prevBalance = await getBalance(baseToken, baseTokenAddress, owner);
                const prevGovBalance = await govToken.balanceOf(owner);

                const res = await liquidityProtection.removeLiquidity(protectionId, 800000);
                protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                expect(protectionIds.length).to.eql(1);

                let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
                protection = getProtection(protection);

                expect(protection.poolAmount).to.be.bignumber.equal(prevProtection.poolAmount.div(new BN(5)));
                expect(protection.reserveAmount).to.be.bignumber.equal(prevProtection.reserveAmount.div(new BN(5)));

                let transactionCost = new BN(0);
                if (isETHReserve) {
                    transactionCost = await getTransactionCost(res);
                }

                // verify balances
                const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
                expect(systemBalance).to.be.bignumber.equal(
                    prevSystemBalance.sub(prevProtection.poolAmount.sub(protection.poolAmount))
                );

                const storeBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
                // double since system balance was also liquidated
                const delta = prevProtection.poolAmount.sub(protection.poolAmount).mul(new BN(2));
                expect(storeBalance).to.be.bignumber.equal(prevStoreBalance.sub(delta));

                const balance = await getBalance(baseToken, baseTokenAddress, owner);
                expect(balance).to.be.bignumber.equal(prevBalance.add(new BN(800)).sub(transactionCost));

                const govBalance = await govToken.balanceOf.call(owner);
                expect(govBalance).to.be.bignumber.equal(prevGovBalance);

                const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
                expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

                const protectionBaseBalance = await getBalance(
                    baseToken,
                    baseTokenAddress,
                    liquidityProtection.address
                );
                expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

                const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
                expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
            });

            it('should revert when attempting to remove zero portion of the liquidity', async () => {
                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );
                let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];

                await expectRevert(liquidityProtection.removeLiquidity(protectionId, 0), 'ERR_INVALID_PERCENT');
            });

            it('should revert when attempting to remove more than 100% of the liquidity', async () => {
                const reserveAmount = new BN(1000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );
                let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];

                await expectRevert(
                    liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION.add(new BN(1))),
                    'ERR_INVALID_PERCENT'
                );
            });

            it('should revert when attempting to remove liquidity that does not exist', async () => {
                await expectRevert(liquidityProtection.removeLiquidity('1234', PPM_RESOLUTION), 'ERR_ACCESS_DENIED');
            });

            it('should revert when attempting to remove liquidity that belongs to another account', async () => {
                let reserveAmount = new BN(5000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );

                const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];

                await expectRevert(
                    liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION, { from: accounts[1] }),
                    'ERR_ACCESS_DENIED'
                );
            });

            it('should revert when attempting to remove liquidity from a non whitelisted pool', async () => {
                let reserveAmount = new BN(5000);
                await addProtectedLiquidity(
                    poolToken.address,
                    baseToken,
                    baseTokenAddress,
                    reserveAmount,
                    isETHReserve
                );

                const protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                const protectionId = protectionIds[0];

                await liquidityProtection.whitelistPool(poolToken.address, false);

                await expectRevert(
                    liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION),
                    'ERR_POOL_NOT_WHITELISTED'
                );
            });
        });
    }

    describe('network token', () => {
        it('verifies that the caller can remove entire protection', async () => {
            let reserveAmount = new BN(5000);
            await baseToken.transfer(accounts[1], 5000);
            await addProtectedLiquidity(
                poolToken.address,
                baseToken,
                baseTokenAddress,
                reserveAmount,
                false,
                accounts[1]
            );

            reserveAmount = new BN(1000);
            await addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, reserveAmount);
            let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            const protectionId = protectionIds[0];
            let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
            protection = getProtection(protection);

            const prevSystemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            const prevStoreBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
            const prevBalance = await getBalance(networkToken, networkToken.address, owner);
            const prevGovBalance = await govToken.balanceOf(owner);

            await liquidityProtection.removeLiquidity(protectionIds[0], PPM_RESOLUTION);
            protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            expect(protectionIds.length).to.eql(0);

            // verify balances
            const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            expect(systemBalance).to.be.bignumber.equal(prevSystemBalance.add(protection.poolAmount));

            const storeBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
            expect(storeBalance).to.be.bignumber.equal(prevStoreBalance);

            const balance = await getBalance(networkToken, networkToken.address, owner);
            expectAlmostEqual(balance, prevBalance.add(reserveAmount));

            const govBalance = await govToken.balanceOf.call(owner);
            expect(govBalance).to.be.bignumber.equal(prevGovBalance.sub(reserveAmount));

            const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
            expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

            const protectionBaseBalance = await getBalance(baseToken, baseTokenAddress, liquidityProtection.address);
            expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

            const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
            expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
        });

        it('verifies that the caller can remove a portion of a protection', async () => {
            let reserveAmount = new BN(5000);
            await baseToken.transfer(accounts[1], 5000);
            await addProtectedLiquidity(
                poolToken.address,
                baseToken,
                baseTokenAddress,
                reserveAmount,
                false,
                accounts[1]
            );

            reserveAmount = new BN(1000);
            await addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, reserveAmount);
            let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            const protectionId = protectionIds[0];
            let prevProtection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
            prevProtection = getProtection(prevProtection);

            const prevSystemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            const prevStoreBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
            const prevBalance = await getBalance(networkToken, networkToken.address, owner);
            const prevGovBalance = await govToken.balanceOf(owner);

            await liquidityProtection.removeLiquidity(protectionId, 800000);
            protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            expect(protectionIds.length).to.eql(1);

            let protection = await liquidityProtectionStore.protectedLiquidity.call(protectionId);
            protection = getProtection(protection);

            expect(protection.poolAmount).to.be.bignumber.equal(prevProtection.poolAmount.div(new BN(5)));
            expect(protection.reserveAmount).to.be.bignumber.equal(prevProtection.reserveAmount.div(new BN(5)));

            // verify balances
            const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
            expect(systemBalance).to.be.bignumber.equal(
                prevSystemBalance.add(prevProtection.poolAmount.sub(protection.poolAmount))
            );

            const storeBalance = await poolToken.balanceOf(liquidityProtectionStore.address);
            expect(storeBalance).to.be.bignumber.equal(prevStoreBalance);

            const balance = await getBalance(networkToken, networkToken.address, owner);
            expectAlmostEqual(balance, prevBalance.add(new BN(800)));

            const govBalance = await govToken.balanceOf.call(owner);
            expect(govBalance).to.be.bignumber.equal(prevGovBalance.sub(new BN(800)));

            const protectionPoolBalance = await poolToken.balanceOf(liquidityProtection.address);
            expect(protectionPoolBalance).to.be.bignumber.equal(new BN(0));

            const protectionBaseBalance = await getBalance(baseToken, baseTokenAddress, liquidityProtection.address);
            expect(protectionBaseBalance).to.be.bignumber.equal(new BN(0));

            const protectionNetworkBalance = await networkToken.balanceOf(liquidityProtection.address);
            expect(protectionNetworkBalance).to.be.bignumber.equal(new BN(0));
        });
    });

    describe('claimBalance', () => {
        beforeEach(async () => {
            await addProtectedLiquidity(poolToken.address, baseToken, baseTokenAddress, new BN(20000));
            await addProtectedLiquidity(poolToken.address, networkToken, networkToken.address, new BN(2000));
            let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
            const protectionId = protectionIds[protectionIds.length - 1];
            await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION / 2);
            await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION / 2);
        });

        it('verifies that locked balance owner can claim locked tokens if sufficient time has passed', async () => {
            const timestamp = await getTimestamp(PROTECTION_FULL_PROTECTION);
            await liquidityProtection.setTime(timestamp);

            const prevBalance = await networkToken.balanceOf(owner);
            const lockedBalance = (await liquidityProtectionStore.lockedBalance(owner, 0))[0];
            const prevTotalLockedBalance = await getLockedBalance(owner);

            await liquidityProtection.claimBalance(0, 1);

            const balance = await networkToken.balanceOf(owner);
            expect(balance).to.be.bignumber.equal(prevBalance.add(lockedBalance));

            const totalLockedBalance = await getLockedBalance(owner);
            expect(totalLockedBalance).to.be.bignumber.equal(prevTotalLockedBalance.sub(lockedBalance));
        });

        it('verifies that locked balance owner can claim multiple locked tokens if sufficient time has passed', async () => {
            const timestamp = await getTimestamp(PROTECTION_FULL_PROTECTION);
            await liquidityProtection.setTime(timestamp);

            const prevBalance = await networkToken.balanceOf(owner);
            const prevTotalLockedBalance = await getLockedBalance(owner);

            await liquidityProtection.claimBalance(0, 2);

            const balance = await networkToken.balanceOf(owner);
            expect(balance).to.be.bignumber.equal(prevBalance.add(prevTotalLockedBalance));

            const totalLockedBalance = await getLockedBalance(owner);
            expect(totalLockedBalance).to.be.bignumber.equal(new BN(0));

            const lockedBalanceCount = await liquidityProtectionStore.lockedBalanceCount(owner);
            expect(lockedBalanceCount).to.be.bignumber.equal(new BN(0));
        });

        it('verifies that attempting to claim tokens that are still locked does not change any balance', async () => {
            const prevBalance = await networkToken.balanceOf(owner);
            const prevTotalLockedBalance = await getLockedBalance(owner);

            await liquidityProtection.claimBalance(0, 2);

            const balance = await networkToken.balanceOf(owner);
            expect(balance).to.be.bignumber.equal(prevBalance);

            const totalLockedBalance = await getLockedBalance(owner);
            expect(totalLockedBalance).to.be.bignumber.equal(prevTotalLockedBalance);
        });

        it('should revert when locked balance owner attempts claim tokens with invalid indices', async () => {
            await expectRevert(liquidityProtection.claimBalance(2, 3), 'ERR_INVALID_INDICES');
        });
    });

    describe('remove liquidity', () => {
        const protectionText = {
            [PROTECTION_NO_PROTECTION]: 'no protection',
            [PROTECTION_PARTIAL_PROTECTION]: 'partial protection',
            [PROTECTION_FULL_PROTECTION]: 'full protection',
            [PROTECTION_EXCESSIVE_PROTECTION]: 'excessive protection'
        };

        const rateChangeText = {
            0: 'no rate change',
            1: 'price increase',
            2: 'price decrease'
        };

        for (let reserve = 0; reserve < 2; reserve++) {
            for (let rateChange = 0; rateChange < 3; rateChange++) {
                for (let withFee = 0; withFee < 2; withFee++) {
                    for (
                        let protection = PROTECTION_NO_PROTECTION;
                        protection <= PROTECTION_EXCESSIVE_PROTECTION;
                        protection++
                    ) {
                        context(
                            `(${reserve == 0 ? 'base token' : 'network token'}) with ${
                                protectionText[protection]
                            } and ${rateChangeText[rateChange]} ${withFee ? 'with fee' : 'without fee'}`,
                            () => {
                                let reserveAmount = new BN(5000);
                                let reserveToken;
                                let reserveAddress;
                                let otherReserveAddress;
                                let timestamp;

                                beforeEach(async () => {
                                    await addProtectedLiquidity(
                                        poolToken.address,
                                        baseToken,
                                        baseTokenAddress,
                                        reserveAmount
                                    );

                                    reserveToken = baseToken;
                                    reserveAddress = baseTokenAddress;
                                    otherReserveAddress = networkToken.address;

                                    if (reserve != 0) {
                                        // adding more liquidity so that the system has enough pool tokens
                                        await addProtectedLiquidity(
                                            poolToken.address,
                                            baseToken,
                                            baseTokenAddress,
                                            new BN(20000)
                                        );
                                        await addProtectedLiquidity(
                                            poolToken.address,
                                            networkToken,
                                            networkToken.address,
                                            reserveAmount
                                        );

                                        [reserveToken, reserveAddress, otherReserveAddress] = [
                                            networkToken,
                                            otherReserveAddress,
                                            reserveAddress
                                        ];
                                    }

                                    if (withFee) {
                                        await generateFee();
                                    }

                                    if (rateChange == 1) {
                                        await increaseRate(reserveAddress);
                                    } else if (rateChange == 2) {
                                        await increaseRate(otherReserveAddress);
                                    }

                                    timestamp = await getTimestamp(protection);
                                    await liquidityProtection.setTime(timestamp);
                                    await converter.setTime(timestamp);
                                });

                                const isLoss =
                                    (protection == PROTECTION_NO_PROTECTION ||
                                        protection == PROTECTION_PARTIAL_PROTECTION) &&
                                    rateChange != 0;
                                const shouldLock = reserve == 1 || rateChange == 1; // || (rateChange == 0 && withFee);

                                if (isLoss) {
                                    it('verifies that removeLiquidityReturn returns an amount that is smaller than the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const amount = (
                                            await liquidityProtection.removeLiquidityReturn(
                                                protectionId,
                                                PPM_RESOLUTION,
                                                timestamp
                                            )
                                        )[0];

                                        expect(amount).to.be.bignumber.lt(reserveAmount);
                                    });

                                    it('verifies that removeLiquidity returns an amount that is smaller than the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const prevBalance = await getBalance(reserveToken, reserveAddress, owner);
                                        await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION);
                                        const balance = await getBalance(reserveToken, reserveAddress, owner);

                                        let lockedBalance = await getLockedBalance(owner);
                                        if (reserveAddress == baseTokenAddress) {
                                            const rate = await getRate(networkToken.address);
                                            lockedBalance = lockedBalance.mul(rate.n).div(rate.d);
                                        }

                                        expect(balance.sub(prevBalance).add(lockedBalance)).to.be.bignumber.lt(
                                            reserveAmount
                                        );
                                    });
                                } else if (withFee) {
                                    it('verifies that removeLiquidityReturn returns an amount that is larger than the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const amount = (
                                            await liquidityProtection.removeLiquidityReturn(
                                                protectionId,
                                                PPM_RESOLUTION,
                                                timestamp
                                            )
                                        )[0];

                                        expect(amount).to.be.bignumber.gt(reserveAmount);
                                    });

                                    it('verifies that removeLiquidity returns an amount that is larger than the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const prevBalance = await getBalance(reserveToken, reserveAddress, owner);
                                        await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION);
                                        const balance = await getBalance(reserveToken, reserveAddress, owner);

                                        let lockedBalance = await getLockedBalance(owner);
                                        if (reserveAddress == baseTokenAddress) {
                                            const rate = await getRate(networkToken.address);
                                            lockedBalance = lockedBalance.mul(rate.n).div(rate.d);
                                        }

                                        expect(balance.sub(prevBalance).add(lockedBalance)).to.be.bignumber.gt(
                                            reserveAmount
                                        );
                                    });
                                } else {
                                    it('verifies that removeLiquidityReturn returns an amount that is almost equal to the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const amount = (
                                            await liquidityProtection.removeLiquidityReturn(
                                                protectionId,
                                                PPM_RESOLUTION,
                                                timestamp
                                            )
                                        )[0];

                                        expectAlmostEqual(amount, reserveAmount);
                                    });

                                    it('verifies that removeLiquidity returns an amount that is almost equal to the initial amount', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        const prevBalance = await getBalance(reserveToken, reserveAddress, owner);
                                        await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION);
                                        const balance = await getBalance(reserveToken, reserveAddress, owner);

                                        let lockedBalance = await getLockedBalance(owner);
                                        if (reserveAddress == baseTokenAddress) {
                                            const rate = await getRate(networkToken.address);
                                            lockedBalance = lockedBalance.mul(rate.n).div(rate.d);
                                        }

                                        expectAlmostEqual(balance.sub(prevBalance).add(lockedBalance), reserveAmount);
                                    });
                                }

                                if (shouldLock) {
                                    it('verifies that removeLiquidity locks network tokens for the caller', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION);

                                        const lockedBalanceCount = await liquidityProtectionStore.lockedBalanceCount(
                                            owner
                                        );
                                        expect(lockedBalanceCount).to.be.bignumber.equal(new BN(1));

                                        const lockedBalance = await getLockedBalance(owner);
                                        expect(lockedBalance).to.be.bignumber.gt(new BN(0));
                                    });
                                } else {
                                    it('verifies that removeLiquidity does not lock network tokens for the caller', async () => {
                                        let protectionIds = await liquidityProtectionStore.protectedLiquidityIds(owner);
                                        const protectionId = protectionIds[protectionIds.length - 1];

                                        await liquidityProtection.removeLiquidity(protectionId, PPM_RESOLUTION);

                                        const lockedBalanceCount = await liquidityProtectionStore.lockedBalanceCount(
                                            owner
                                        );
                                        expect(lockedBalanceCount).to.be.bignumber.equal(new BN(0));

                                        const lockedBalance = await getLockedBalance(owner);
                                        expect(lockedBalance).to.be.bignumber.equal(new BN(0));
                                    });
                                }
                            }
                        );
                    }
                }
            }
        }
    });
});
