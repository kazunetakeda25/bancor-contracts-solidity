/* global artifacts, contract, before, it, assert, web3 */
/* eslint-disable prefer-reflect */

const utils = require('./helpers/Utils');
const ContractRegistryClient = require('./helpers/ContractRegistryClient');

const ERC20Token = artifacts.require('ERC20Token');
const SmartToken = artifacts.require('SmartToken');
const ContractRegistry = artifacts.require('ContractRegistry');
const BancorConverter = artifacts.require('BancorConverter');
const BancorConverterFactory = artifacts.require('BancorConverterFactory');
const BancorConverterRegistry = artifacts.require('BancorConverterRegistry');
const BancorConverterRegistryData = artifacts.require('BancorConverterRegistryData');
const BancorNetworkPathFinder = artifacts.require('BancorNetworkPathFinder');

const ETH_RESERVE_ADDRESS = '0x'.padEnd(42, 'e');

const ANCHOR_TOKEN_SYMBOL = 'ETH';

const layout = {
    'reserves': [
        {'symbol': 'AAA'},
        {'symbol': 'BBB'},
        {'symbol': 'CCC'},
        {'symbol': 'DDD'},
    ],
    'converters': [
        {'symbol': 'BNT'         , 'reserves': [{'symbol': 'ETH'   }                        ]},
        {'symbol': 'AAABNT'      , 'reserves': [{'symbol': 'AAA'   },{'symbol': 'BNT'      }]},
        {'symbol': 'BBBBNT'      , 'reserves': [{'symbol': 'BBB'   },{'symbol': 'BNT'      }]},
        {'symbol': 'CCCBNT'      , 'reserves': [{'symbol': 'CCC'   },{'symbol': 'BNT'      }]},
        {'symbol': 'AAABNTBNT'   , 'reserves': [{'symbol': 'AAABNT'},{'symbol': 'BNT'      }]},
        {'symbol': 'BBBBNTBNT'   , 'reserves': [{'symbol': 'BBBBNT'},{'symbol': 'BNT'      }]},
        {'symbol': 'DDDAAABNTBNT', 'reserves': [{'symbol': 'DDD'   },{'symbol': 'AAABNTBNT'}]},
    ]
};

async function getSymbol(tokenAddress) {
    if (tokenAddress == ETH_RESERVE_ADDRESS)
        return 'ETH';
    return await ERC20Token.at(tokenAddress).symbol();
}

async function printPath(sourceToken, targetToken, path) {
    const sourceSymbol = await getSymbol(sourceToken);
    const targetSymbol = await getSymbol(targetToken);
    const symbols = await Promise.all(path.map(token => getSymbol(token)));
    console.log(`path from ${sourceSymbol} to ${targetSymbol} = [${symbols}]`);
}

async function generatePath(sourceToken, targetToken, anchorToken, converterRegistry) {
    const sourcePath = await getPath(sourceToken, anchorToken, converterRegistry);
    const targetPath = await getPath(targetToken, anchorToken, converterRegistry);
    return getShortestPath(sourcePath, targetPath);
}

async function getPath(token, anchorToken, converterRegistry) {
    if (token == anchorToken)
        return [token];

    const isSmartToken = await converterRegistry.isSmartToken(token);
    const smartTokens = isSmartToken ? [token] : await converterRegistry.getConvertibleTokenSmartTokens(token);
    for (const smartToken of smartTokens) {
        const converter = BancorConverter.at(await SmartToken.at(smartToken).owner());
        const connectorTokenCount = await converter.connectorTokenCount();
        for (let i = 0; i < connectorTokenCount; i++) {
            const connectorToken = await converter.connectorTokens(i);
            if (connectorToken != token) {
                const path = await getPath(connectorToken, anchorToken, converterRegistry);
                if (path.length > 0)
                    return [token, smartToken, ...path];
            }
        }
    }

    return [];
}

function getShortestPath(sourcePath, targetPath) {
    if (sourcePath.length > 0 && targetPath.length > 0) {
        let i = sourcePath.length - 1;
        let j = targetPath.length - 1;
        while (i >= 0 && j >= 0 && sourcePath[i] == targetPath[j]) {
            i--;
            j--;
        }

        const path = [];
        for (let m = 0; m <= i + 1; m++)
            path.push(sourcePath[m]);
        for (let n = j; n >= 0; n--)
            path.push(targetPath[n]);

        let length = 0;
        for (let p = 0; p < path.length; p += 1) {
            for (let q = p + 2; q < path.length - p % 2; q += 2) {
                if (path[p] == path[q])
                    p = q;
            }
            path[length++] = path[p];
        }

        return path.slice(0, length);
    }

    return [];
}

contract('BancorNetworkPathFinder', accounts => {
    let contractRegistry
    let converterFactory;
    let converterRegistry;
    let converterRegistryData;
    let pathFinder;
    let anchorToken;

    const addresses = {ETH: ETH_RESERVE_ADDRESS};

    before(async function() {
        contractRegistry = await ContractRegistry.new();

        converterFactory      = await BancorConverterFactory     .new();
        converterRegistry     = await BancorConverterRegistry    .new(contractRegistry.address);
        converterRegistryData = await BancorConverterRegistryData.new(contractRegistry.address);
        pathFinder            = await BancorNetworkPathFinder    .new(contractRegistry.address);

        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_FACTORY      , converterFactory     .address);
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_REGISTRY     , converterRegistry    .address);
        await contractRegistry.registerAddress(ContractRegistryClient.BANCOR_CONVERTER_REGISTRY_DATA, converterRegistryData.address);

        for (const reserve of layout.reserves) {
            const token = await ERC20Token.new('name', reserve.symbol, 0, 0);
            addresses[reserve.symbol] = token.address;
        }

        for (const converter of layout.converters) {
            const tokens = converter.reserves.map(reserve => addresses[reserve.symbol]);
            await converterRegistry.newConverter(0, 'name', converter.symbol, 0, 0, tokens, tokens.map(token => 1));
            const smartTokens = await converterRegistry.getSmartTokens();
            const token = SmartToken.at(smartTokens.slice(-1)[0]);
            addresses[converter.symbol] = token.address;
        }

        const smartTokens = await converterRegistry.getSmartTokens();
        const bancorConverters = await Promise.all(smartTokens.map(smartToken => SmartToken.at(smartToken).owner()));
        await Promise.all(bancorConverters.map(bancorConverter => BancorConverter.at(bancorConverter).acceptOwnership()));

        anchorToken = addresses[ANCHOR_TOKEN_SYMBOL];
        await pathFinder.setAnchorToken(anchorToken);
    });

    it('should throw when a non owner tries to update the anchor token', async () => {
        await utils.catchRevert(pathFinder.setAnchorToken(accounts[0], {from: accounts[1]}));
        assert.equal(await pathFinder.anchorToken(), anchorToken);
    });

    it('should return an empty path if the source-token has no path to the anchor-token', async () => {
        const sourceToken = accounts[0];
        const targetToken = anchorToken;
        const expected = await generatePath(sourceToken, targetToken, anchorToken, converterRegistry);
        const actual = await pathFinder.generatePath(sourceToken, targetToken);
        assert.equal(actual + expected, []);
    });

    it('should return an empty path if the target-token has no path to the anchor-token', async () => {
        const sourceToken = anchorToken;
        const targetToken = accounts[0];
        const expected = await generatePath(sourceToken, targetToken, anchorToken, converterRegistry);
        const actual = await pathFinder.generatePath(sourceToken, targetToken);
        assert.equal(actual + expected, []);
    });

    const allSymbols = ['ETH', ...[...layout.reserves, ...layout.converters].map(record => record.symbol)];
    for (const sourceSymbol of allSymbols) {
        for (const targetSymbol of allSymbols) {
            it(`from ${sourceSymbol} to ${targetSymbol}`, async () => {
                const sourceToken = addresses[sourceSymbol];
                const targetToken = addresses[targetSymbol];
                const expected = await generatePath(sourceToken, targetToken, anchorToken, converterRegistry);
                const actual = await pathFinder.generatePath(sourceToken, targetToken);
                assert.equal(`${actual}`, `${expected}`);
                await printPath(sourceToken, targetToken, actual);
            });
        }
    }
});
