const { expect } = require('chai');
const { BN, constants } = require('@openzeppelin/test-helpers');
const { registry } = require('./helpers/Constants');
const Decimal = require('decimal.js');

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

const f = (a, b) => [].concat(...a.map(d => b.map(e => [].concat(d, e))));
const cartesian = (a, b, ...c) => (b ? cartesian(f(a, b), ...c) : a);

function decimalToInteger(value, decimals) {
    const parts = [...value.split('.'), ''];
    return parts[0] + parts[1].padEnd(decimals, '0');
}

function percentageToPPM(value) {
    return decimalToInteger(value.replace('%', ''), 4);
}

function condOrAlmostEqual(cond, actual, expected, maxError) {
    if (!cond) {
        const error = Decimal(actual.toString()).div(expected.toString()).sub(1).abs();
        if (error.gt(maxError)) {
            return `error = ${error.toFixed(maxError.length)}`;
        }
    }
    return '';
}

const CONFIGURATIONS = [
    {increaseRate: false, generateFee: false},
    {increaseRate: false, generateFee: true},
    {increaseRate: true, generateFee: false}
];

const NUM_OF_DAYS = [30, 100];
const DECIMAL_COMBINATIONS = cartesian([12, 25], [12, 25], [15, 22], [15, 22]);

const FULL_PPM = percentageToPPM('100%');
const HALF_PPM = percentageToPPM('50%');
const FEE_PPM = percentageToPPM('1%');

contract('LiquidityProtectionEdgeCases', accounts => {
    const addProtectedLiquidity = async (token, amount) => {
        await token.approve(liquidityProtection.address, amount);
        await liquidityProtection.addLiquidity(poolToken.address, token.address, amount);
    };

    const convert = async (sourceToken, targetToken, amount) => {
        await sourceToken.approve(bancorNetwork.address, amount);
        const path = [sourceToken.address, poolToken.address, targetToken.address];
        await bancorNetwork.convertByPath(path, amount, 1, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS, 0);
    };

    const increaseRate = async (sourceToken, targetToken, amount) => {
        await convert(
            sourceToken,
            targetToken,
            new BN(Decimal(2).sqrt().sub(1).mul(amount.toString()).toFixed(0))
        );
    };

    const generateFee = async (conversionFee, sourceToken, targetToken, amount) => {
        await converter.setConversionFee(conversionFee);
        const prevBalance = await targetToken.balanceOf(owner);
        await convert(sourceToken, targetToken, amount.div(new BN(2)));
        const currBalance = await targetToken.balanceOf(owner);
        await convert(targetToken, sourceToken, currBalance.sub(prevBalance));
        await converter.setConversionFee(0);
    };

    const getNetworkTokenMaxAmount = async () => {
        const totalSupply = await poolToken.totalSupply();
        const reserveBalance = await converter.reserveBalance(networkToken.address);
        const systemBalance = await liquidityProtectionStore.systemBalance(poolToken.address);
        return systemBalance.mul(reserveBalance).div(totalSupply);
    }

    let contractRegistry;
    let converterRegistry;
    let bancorNetwork;
    let baseToken;
    let networkToken;
    let govToken;
    let poolToken;
    let converter;
    let liquidityProtectionStore;
    let liquidityProtection;

    const owner = accounts[0];

    before(async () => {
        contractRegistry = await ContractRegistry.new();
        converterRegistry = await ConverterRegistry.new(contractRegistry.address);
        bancorNetwork = await BancorNetwork.new(contractRegistry.address);

        const converterRegistryData = await ConverterRegistryData.new(contractRegistry.address);

        const liquidityPoolV1ConverterFactory = await LiquidityPoolV1ConverterFactory.new();
        const converterFactory = await ConverterFactory.new();
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
        baseToken = await DSToken.new('TKN', 'TKN', 18);
        networkToken = await DSToken.new('BNT', 'BNT', 18);
        govToken = await DSToken.new('vBNT', 'vBNT', 18);

        await baseToken.issue(owner, new BN('1'.padEnd(30, '0')));
        await networkToken.issue(owner, new BN('1'.padEnd(30, '0')));

        await converterRegistry.newConverter(1, 'PT', 'PT', 18, FULL_PPM, [baseToken.address, networkToken.address], [HALF_PPM, HALF_PPM]);
        const anchorCount = await converterRegistry.getAnchorCount();
        const poolTokenAddress = await converterRegistry.getAnchor(anchorCount.sub(new BN(1)));
        poolToken = await DSToken.at(poolTokenAddress);
        const converterAddress = await poolToken.owner();
        converter = await LiquidityPoolV1Converter.at(converterAddress);
        await converter.acceptOwnership();

        liquidityProtectionStore = await LiquidityProtectionStore.new(contractRegistry.address);
        liquidityProtection = await LiquidityProtection.new(liquidityProtectionStore.address, networkToken.address, govToken.address, contractRegistry.address);
        await liquidityProtectionStore.transferOwnership(liquidityProtection.address);
        await networkToken.transferOwnership(liquidityProtection.address);
        await govToken.transferOwnership(liquidityProtection.address);
        await liquidityProtection.acceptStoreOwnership();
        await liquidityProtection.acceptNetworkTokenOwnership();
        await liquidityProtection.acceptGovTokenOwnership();
        await liquidityProtection.whitelistPool(poolToken.address, true);
        await liquidityProtection.setSystemNetworkTokenLimits(-1, FULL_PPM);
    });

    for (const config of CONFIGURATIONS) {
        for (const numOfDays of NUM_OF_DAYS) {
            for (const decimals of DECIMAL_COMBINATIONS) {

                let test;
                if (!config.increaseRate && !config.generateFee) {
                    test = (actual, expected) => condOrAlmostEqual(actual.eq(expected), actual, expected, '0.000000000000001');
                }
                else if (!config.increaseRate && config.generateFee) {
                    test = (actual, expected) => condOrAlmostEqual(actual.gt(expected), actual, expected, '0.0');
                }
                else if (config.increaseRate && !config.generateFee && numOfDays < 100) {
                    test = (actual, expected) => condOrAlmostEqual(actual.lt(expected), actual, expected, '0.0000000000000001');
                }
                else if (config.increaseRate && !config.generateFee && numOfDays >= 100) {
                    test = (actual, expected) => condOrAlmostEqual(actual.eq(expected), actual, expected, '0.000000000000001');
                }
                else {
                    throw new Error('invalid configuration');
                }

                it(`base token, increaseRate = ${config.increaseRate}, generateFee = ${config.generateFee}, numOfDays = ${numOfDays}, decimals = ${decimals}`, async () => {
                    const amounts = decimals.map(n => new BN(10).pow(new BN(n)));

                    await baseToken.approve(converter.address, amounts[0]);
                    await networkToken.approve(converter.address, amounts[1]);
                    await converter.addLiquidity([baseToken.address, networkToken.address], [amounts[0], amounts[1]], 1);
    
                    await addProtectedLiquidity(baseToken, amounts[2]);
                    const networkTokenMaxAmount = await getNetworkTokenMaxAmount();
                    if (amounts[3].gt(networkTokenMaxAmount))
                        amounts[3] = networkTokenMaxAmount;
                    await addProtectedLiquidity(networkToken, amounts[3]);
    
                    if (config.increaseRate) {
                        await increaseRate(networkToken, baseToken, amounts[3]);
                    }
    
                    if (config.generateFee) {
                        await generateFee(FEE_PPM, baseToken, networkToken, amounts[2]);
                    }
    
                    const actual = await liquidityProtection.removeLiquidityReturn(0, FULL_PPM, numOfDays * 24 * 60 * 60 + 1);
                    const error = test(actual[0], amounts[2]);
                    expect(error).to.be.empty(error);
                });
            }
        }
    }

    for (const config of CONFIGURATIONS) {
        for (const numOfDays of NUM_OF_DAYS) {
            for (const decimals of DECIMAL_COMBINATIONS) {

                let test;
                if (!config.increaseRate && !config.generateFee) {
                    test = (actual, expected) => condOrAlmostEqual(actual.eq(expected), actual, expected, '0.00000000000001');
                }
                else if (!config.increaseRate && config.generateFee) {
                    test = (actual, expected) => condOrAlmostEqual(actual.gt(expected), actual, expected, '0.0');
                }
                else if (config.increaseRate && !config.generateFee && numOfDays < 100) {
                    test = (actual, expected) => condOrAlmostEqual(actual.lt(expected), actual, expected, '0.00000000000000001');
                }
                else if (config.increaseRate && !config.generateFee && numOfDays >= 100) {
                    test = (actual, expected) => condOrAlmostEqual(actual.eq(expected), actual, expected, '0.0000001');
                }
                else {
                    throw new Error('invalid configuration');
                }

                it(`network token, increaseRate = ${config.increaseRate}, generateFee = ${config.generateFee}, numOfDays = ${numOfDays}, decimals = ${decimals}`, async () => {
                    const amounts = decimals.map(n => new BN(10).pow(new BN(n)));

                    await baseToken.approve(converter.address, amounts[0]);
                    await networkToken.approve(converter.address, amounts[1]);
                    await converter.addLiquidity([baseToken.address, networkToken.address], [amounts[0], amounts[1]], 1);

                    await addProtectedLiquidity(baseToken, amounts[2]);
                    const networkTokenMaxAmount = await getNetworkTokenMaxAmount();
                    if (amounts[3].gt(networkTokenMaxAmount))
                        amounts[3] = networkTokenMaxAmount;
                    await addProtectedLiquidity(networkToken, amounts[3]);

                    if (config.increaseRate) {
                        await increaseRate(baseToken, networkToken, amounts[2]);
                    }

                    if (config.generateFee) {
                        await generateFee(FEE_PPM, networkToken, baseToken, amounts[3]);
                    }

                    const actual = await liquidityProtection.removeLiquidityReturn(1, FULL_PPM, numOfDays * 24 * 60 * 60 + 1);
                    const error = test(actual[0], amounts[3]);
                    expect(error).to.be.empty(error);
                });
            }
        }
    }
});
