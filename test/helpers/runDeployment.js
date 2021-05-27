const decimalToInteger = (value, decimals) => {
    const parts = [...value.split('.'), ''];
    return parts[0] + parts[1].padEnd(decimals, '0');
};

const percentageToPPM = (value) => {
    return decimalToInteger(value.replace('%', ''), 4);
};

module.exports = async (account, deploy, deployed, execute, getConfig, keccak256, asciiToHex, getTransactionCount) => {
    const ROLE_OWNER = keccak256('ROLE_OWNER');
    const ROLE_GOVERNOR = keccak256('ROLE_GOVERNOR');
    const ROLE_MINTER = keccak256('ROLE_MINTER');
    const ROLE_PUBLISHER = keccak256('ROLE_PUBLISHER');

    const reserves = {
        ETH: {
            address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
            decimals: 18
        }
    };

    // main contracts
    const contractRegistry = await deploy('contractRegistry', 'ContractRegistry');
    const converterFactory = await deploy('converterFactory', 'ConverterFactory');
    const bancorNetwork = await deploy('bancorNetwork', 'BancorNetwork', contractRegistry.address);
    const conversionPathFinder = await deploy('conversionPathFinder', 'ConversionPathFinder', contractRegistry.address);
    const converterUpgrader = await deploy('converterUpgrader', 'ConverterUpgrader', contractRegistry.address);
    const converterRegistry = await deploy('converterRegistry', 'ConverterRegistry', contractRegistry.address);
    const converterRegistryData = await deploy(
        'converterRegistryData',
        'ConverterRegistryData',
        contractRegistry.address
    );

    const networkFeeWallet = await deploy('networkFeeWallet', 'TokenHolder');
    const networkSettings = await deploy('networkSettings', 'NetworkSettings', networkFeeWallet.address, 0);

    const standardPoolConverterFactory = await deploy('standardPoolConverterFactory', 'StandardPoolConverterFactory');

    // contract deployment for etherscan verification only
    const poolToken1 = await deploy('poolToken1', 'DSToken', 'Token1', 'TKN1', 18);
    await deploy('standardPoolConverter', 'StandardPoolConverter', poolToken1.address, contractRegistry.address, 1000);

    // initialize contract registry
    await execute(contractRegistry.registerAddress(asciiToHex('ContractRegistry'), contractRegistry.address));
    await execute(contractRegistry.registerAddress(asciiToHex('ConverterFactory'), converterFactory.address));
    await execute(contractRegistry.registerAddress(asciiToHex('BancorNetwork'), bancorNetwork.address));
    await execute(contractRegistry.registerAddress(asciiToHex('NetworkSettings'), networkSettings.address));

    await execute(contractRegistry.registerAddress(asciiToHex('ConversionPathFinder'), conversionPathFinder.address));
    await execute(contractRegistry.registerAddress(asciiToHex('BancorConverterUpgrader'), converterUpgrader.address));
    await execute(contractRegistry.registerAddress(asciiToHex('BancorConverterRegistry'), converterRegistry.address));
    await execute(
        contractRegistry.registerAddress(asciiToHex('BancorConverterRegistryData'), converterRegistryData.address)
    );

    // initialize converter factory
    await execute(converterFactory.registerTypedConverterFactory(standardPoolConverterFactory.address));

    for (const reserve of getConfig().reserves) {
        if (reserve.address) {
            const token = await deployed('ERC20', reserve.address);
            const symbol = await token.symbol();
            const decimals = await token.decimals();
            reserves[symbol] = { address: token.address, decimals: decimals };
        } else {
            const name = reserve.symbol + ' DS Token';
            const symbol = reserve.symbol;
            const decimals = reserve.decimals;
            const supply = decimalToInteger(reserve.supply, decimals);
            const nonce = await getTransactionCount(account.address);
            const token = await deploy('dsToken-' + symbol, 'DSToken', name, symbol, decimals);
            if (nonce !== (await getTransactionCount(account.address))) {
                await execute(token.issue(account.address, supply));
            }
            reserves[symbol] = { address: token.address, decimals };
        }
    }

    for (const [converter, index] of getConfig().converters.map((converter, index) => [converter, index])) {
        const type = converter.type;
        const name = converter.symbol + ' Liquidity Pool';
        const symbol = converter.symbol;
        const decimals = converter.decimals;
        const fee = percentageToPPM(converter.fee);
        const tokens = converter.reserves.map((reserve) => reserves[reserve.symbol].address);
        const weights = [percentageToPPM('50%'), percentageToPPM('50%')];
        const amounts = converter.reserves.map((reserve) =>
            decimalToInteger(reserve.balance, reserves[reserve.symbol].decimals)
        );
        const value = amounts[converter.reserves.findIndex((reserve) => reserve.symbol === 'ETH')];

        await execute(
            converterRegistry.newConverter(type, name, symbol, decimals, percentageToPPM('100%'), tokens, weights)
        );

        const converterAnchor = await deployed('IConverterAnchor', await converterRegistry.getAnchor(index));

        const standardConverter = await deployed('StandardPoolConverter', await converterAnchor.owner());
        await execute(standardConverter.acceptOwnership());
        await execute(standardConverter.setConversionFee(fee));

        if (amounts.every((amount) => amount > 0)) {
            for (let i = 0; i < converter.reserves.length; i++) {
                const reserve = converter.reserves[i];
                if (reserve.symbol !== 'ETH') {
                    const deployedToken = await deployed('ERC20', tokens[i]);
                    await execute(deployedToken.approve(standardConverter.address, amounts[i]));
                }
            }

            const deployedConverterType = { 3: 'StandardPoolConverter' }[type];
            const deployedConverter = await deployed(deployedConverterType, standardConverter.address);
            await execute(deployedConverter.addLiquidity(tokens, amounts, 1, { value }));
        }

        reserves[converter.symbol] = {
            address: converterAnchor.address,
            decimals: decimals
        };
    }

    await execute(contractRegistry.registerAddress(asciiToHex('BNTToken'), reserves.BNT.address));
    await execute(conversionPathFinder.setAnchorToken(reserves.BNT.address));

    const bntTokenGovernance = await deploy('bntTokenGovernance', 'TokenGovernance', reserves.BNT.address);
    const vbntTokenGovernance = await deploy('vbntTokenGovernance', 'TokenGovernance', reserves.vBNT.address);

    await execute(bntTokenGovernance.grantRole(ROLE_GOVERNOR, account.address));
    await execute(vbntTokenGovernance.grantRole(ROLE_GOVERNOR, account.address));

    const checkpointStore = await deploy('checkpointStore', 'CheckpointStore');

    const stakingRewardsStore = await deploy('stakingRewardsStore', 'StakingRewardsStore');
    const stakingRewards = await deploy(
        'stakingRewards',
        'StakingRewards',
        stakingRewardsStore.address,
        bntTokenGovernance.address,
        checkpointStore.address,
        contractRegistry.address
    );

    const liquidityProtectionSettings = await deploy(
        'liquidityProtectionSettings',
        'LiquidityProtectionSettings',
        reserves.BNT.address,
        contractRegistry.address
    );

    const liquidityProtectionStore = await deploy('liquidityProtectionStore', 'LiquidityProtectionStore');
    const liquidityProtectionStats = await deploy('liquidityProtectionStats', 'LiquidityProtectionStats');
    const liquidityProtectionSystemStore = await deploy(
        'liquidityProtectionSystemStore',
        'LiquidityProtectionSystemStore'
    );
    const liquidityProtectionWallet = await deploy('liquidityProtectionWallet', 'TokenHolder');

    const liquidityProtection = await deploy(
        'liquidityProtection',
        'LiquidityProtection',
        liquidityProtectionSettings.address,
        liquidityProtectionStore.address,
        liquidityProtectionStats.address,
        liquidityProtectionSystemStore.address,
        liquidityProtectionWallet.address,
        bntTokenGovernance.address,
        vbntTokenGovernance.address,
        checkpointStore.address
    );

    await execute(checkpointStore.grantRole(ROLE_OWNER, liquidityProtection.address));

    await execute(stakingRewardsStore.grantRole(ROLE_OWNER, stakingRewards.address));
    await execute(stakingRewards.grantRole(ROLE_PUBLISHER, liquidityProtection.address));
    await execute(bntTokenGovernance.grantRole(ROLE_MINTER, stakingRewards.address));
    await execute(liquidityProtectionSettings.addSubscriber(stakingRewards.address));

    // granting the LP contract both of the MINTER roles requires the deployer to have the GOVERNOR role
    await execute(bntTokenGovernance.grantRole(ROLE_MINTER, liquidityProtection.address));
    await execute(vbntTokenGovernance.grantRole(ROLE_MINTER, liquidityProtection.address));

    await execute(liquidityProtectionStats.grantRole(ROLE_OWNER, liquidityProtection.address));
    await execute(liquidityProtectionSystemStore.grantRole(ROLE_OWNER, liquidityProtection.address));

    await execute(contractRegistry.registerAddress(asciiToHex('LiquidityProtection'), liquidityProtection.address));

    await execute(liquidityProtectionStore.transferOwnership(liquidityProtection.address));
    await execute(liquidityProtection.acceptStoreOwnership());

    await execute(liquidityProtectionWallet.transferOwnership(liquidityProtection.address));
    await execute(liquidityProtection.acceptWalletOwnership());

    const params = getConfig().liquidityProtectionParams;

    const minNetworkTokenLiquidityForMinting = decimalToInteger(
        params.minNetworkTokenLiquidityForMinting,
        reserves.BNT.decimals
    );
    await execute(
        liquidityProtectionSettings.setMinNetworkTokenLiquidityForMinting(minNetworkTokenLiquidityForMinting)
    );

    const defaultNetworkTokenMintingLimit = decimalToInteger(
        params.defaultNetworkTokenMintingLimit,
        reserves.BNT.decimals
    );
    await execute(liquidityProtectionSettings.setDefaultNetworkTokenMintingLimit(defaultNetworkTokenMintingLimit));

    await execute(
        liquidityProtectionSettings.setProtectionDelays(params.minProtectionDelay, params.maxProtectionDelay)
    );
    await execute(liquidityProtectionSettings.setLockDuration(params.lockDuration));

    for (const converter of params.converters) {
        await execute(liquidityProtectionSettings.addPoolToWhitelist(reserves[converter].address));
    }

    const vortexBurner = await deploy(
        'vortexBurner',
        'VortexBurner',
        reserves.BNT.address,
        vbntTokenGovernance.address,
        contractRegistry.address
    );

    await execute(networkFeeWallet.transferOwnership(vortexBurner.address));
    await execute(vortexBurner.acceptNetworkFeeOwnership());
};