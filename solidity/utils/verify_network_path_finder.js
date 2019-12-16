const fs     = require("fs");
const Web3   = require("web3");
const assert = require("assert");

const NODE_ADDRESS   = process.argv[2];
const FINDER_ADDRESS = process.argv[3];

const FINDER_ABI      = JSON.parse(fs.readFileSync(__dirname + "/../build/BancorNetworkPathFinder.abi"));
const REGISTRY_ABI    = JSON.parse(fs.readFileSync(__dirname + "/../build/BancorConverterRegistry.abi"));
const CONVERTER_ABI   = JSON.parse(fs.readFileSync(__dirname + "/../build/BancorConverter.abi"        ));
const SMART_TOKEN_ABI = JSON.parse(fs.readFileSync(__dirname + "/../build/SmartToken.abi"             ));

async function get(web3, sourceToken, targetToken, anchorToken, registry) {
    const sourcePath = await getPath(web3, sourceToken, anchorToken, registry);
    const targetPath = await getPath(web3, targetToken, anchorToken, registry);
    return getShortestPath(sourcePath, targetPath);
}

async function getPath(web3, token, anchorToken, registryContract) {
    if (token == anchorToken)
        return [token];

    const isSmartToken = await rpc(registryContract.methods.isSmartToken(token));
    const smartTokens = isSmartToken ? [token] : await rpc(registryContract.methods.getConvertibleTokenSmartTokens(token));
    for (const smartToken of smartTokens) {
        const smartTokenContract = new web3.eth.Contract(SMART_TOKEN_ABI, smartToken);
        const converterContract = new web3.eth.Contract(CONVERTER_ABI, await rpc(smartTokenContract.methods.owner()));
        const connectorTokenCount = await rpc(converterContract.methods.connectorTokenCount());
        for (let i = 0; i < connectorTokenCount; i++) {
            const connectorToken = await rpc(converterContract.methods.connectorTokens(i));
            if (connectorToken != token) {
                const path = await getPath(web3, connectorToken, anchorToken, registryContract);
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
        for (let n = 0; n <= i + 1; n++)
            path.push(sourcePath[n]);
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

async function rpc(func) {
    while (true) {
        try {
            return await func.call();
        }
        catch (error) {
            if (!error.message.startsWith("Invalid JSON RPC response"))
                throw error;
        }
    }
}

async function symbol(web3, token) {
    for (const type of ["string", "bytes32"]) {
        try {
            const contract = new web3.eth.Contract([{"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":type}],"payable":false,"stateMutability":"view","type":"function"}], token);
            const symbol = await rpc(contract.methods.symbol());
            if (type.startsWith("bytes")) {
                const list = [];
                for (let i = 2; i < symbol.length; i += 2) {
                    const num = Number("0x" + symbol.slice(i, i + 2));
                    if (32 <= num && num <= 126)
                        list.push(num);
                    else
                        break;
                }
                return String.fromCharCode(...list);
            }
            return symbol;
        }
        catch (error) {
        }
    }
    return token;
}

function print(convertibleTokens, i, j, sourceSymbol, targetSymbol, path) {
    const total = convertibleTokens.length ** 2;
    const count = convertibleTokens.length * i + j;
    console.log(`path ${count} out of ${total} (from ${sourceSymbol} to ${targetSymbol}): ${path}`);
}

async function run() {
    const web3 = new Web3(NODE_ADDRESS);
    const finder = new web3.eth.Contract(FINDER_ABI, FINDER_ADDRESS);
    const registry = new web3.eth.Contract(REGISTRY_ABI, await rpc(finder.methods.converterRegistry()));

    const anchorToken = await rpc(finder.methods.anchorToken());
    const convertibleTokens = await rpc(registry.methods.getConvertibleTokens());

    for (let i = 0; i < convertibleTokens.length; i++) {
        const sourceSymbol = await symbol(web3, convertibleTokens[i]);
        for (let j = 0; j < convertibleTokens.length; j++) {
            const targetSymbol = await symbol(web3, convertibleTokens[j]);
            const expected = await get(web3, convertibleTokens[i], convertibleTokens[j], anchorToken, registry);
            const actual = await rpc(finder.methods.get(convertibleTokens[i], convertibleTokens[j]));
            const path = await Promise.all(actual.map(token => symbol(web3, token)));
            print(convertibleTokens, i, j, sourceSymbol, targetSymbol, path);
            assert.equal(`${actual}`, `${expected}`);
        }
    }

    if (web3.currentProvider.constructor.name == "WebsocketProvider")
        web3.currentProvider.connection.close();
}

run();