const fs   = require("fs");
const Web3 = require("web3");

const CFG_FILE_NAME = process.argv[2];
const NODE_ADDRESS  = process.argv[3];
const PRIVATE_KEY   = process.argv[4];

const ARTIFACTS_DIR = __dirname + "/../build/";

const MIN_GAS_LIMIT = 100000;

function get() {
    return JSON.parse(fs.readFileSync(CFG_FILE_NAME, {encoding: "utf8"}));
}

function set(record) {
    fs.writeFileSync(CFG_FILE_NAME, JSON.stringify({...get(), ...record}, null, 4));
}

async function scan(message) {
    process.stdout.write(message);
    return await new Promise(function(resolve, reject) {
        process.stdin.resume();
        process.stdin.once("data", function(data) {
            process.stdin.pause();
            resolve(data.toString().trim());
        });
    });
}

async function getGasPrice(web3) {
    while (true) {
        const nodeGasPrice = await web3.eth.getGasPrice();
        const userGasPrice = await scan(`Enter gas-price or leave empty to use ${nodeGasPrice}: `);
        if (/^\d+$/.test(userGasPrice))
            return userGasPrice;
        if (userGasPrice == "")
            return nodeGasPrice;
        console.log("Illegal gas-price");
    }
}

async function getTransactionReceipt(web3) {
    while (true) {
        const hash = await scan("Enter transaction-hash or leave empty to retry: ");
        if (/^0x([0-9A-Fa-f]{64})$/.test(hash)) {
            const receipt = await web3.eth.getTransactionReceipt(hash);
            if (receipt)
                return receipt;
            console.log("Invalid transaction-hash");
        }
        else if (hash) {
            console.log("Illegal transaction-hash");
        }
        else {
            return null;
        }
    }
}

async function send(web3, account, gasPrice, transaction, value = 0) {
    while (true) {
        try {
            const options = {
                to      : transaction._parent._address,
                data    : transaction.encodeABI(),
                gas     : Math.max(await transaction.estimateGas({from: account.address, value: value}), MIN_GAS_LIMIT),
                gasPrice: gasPrice ? gasPrice : await getGasPrice(web3),
                value   : value,
            };
            const signed  = await web3.eth.accounts.signTransaction(options, account.privateKey);
            const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
            return receipt;
        }
        catch (error) {
            console.log(error.message);
            const receipt = await getTransactionReceipt(web3);
            if (receipt)
                return receipt;
        }
    }
}

async function deploy(web3, account, gasPrice, contractId, contractName, contractArgs) {
    if (get()[contractId] == undefined) {
        const abi = fs.readFileSync(ARTIFACTS_DIR + contractName + ".abi", {encoding: "utf8"});
        const bin = fs.readFileSync(ARTIFACTS_DIR + contractName + ".bin", {encoding: "utf8"});
        const contract = new web3.eth.Contract(JSON.parse(abi));
        const options = {data: "0x" + bin, arguments: contractArgs};
        const transaction = contract.deploy(options);
        const receipt = await send(web3, account, gasPrice, transaction);
        const args = transaction.encodeABI().slice(options.data.length);
        console.log(`${contractId} deployed at ${receipt.contractAddress}`);
        set({[contractId]: {name: contractName, addr: receipt.contractAddress, args: args}});
    }
    return deployed(web3, contractName, get()[contractId].addr);
}

function deployed(web3, contractName, contractAddr) {
    const abi = fs.readFileSync(ARTIFACTS_DIR + contractName + ".abi", {encoding: "utf8"});
    return new web3.eth.Contract(JSON.parse(abi), contractAddr);
}

function decimalToInteger(value, decimals) {
    const parts = [...value.split("."), ""];
    return parts[0] + parts[1].padEnd(decimals, "0");
}

function percentageToPPM(value) {
    return decimalToInteger(value.replace("%", ""), 4);
}

async function run() {
    const web3 = new Web3(NODE_ADDRESS);

    const gasPrice = await getGasPrice(web3);
    const account  = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    const web3Func = (func, ...args) => func(web3, account, gasPrice, ...args);

    const addresses = {ETH: Web3.utils.toChecksumAddress("0x".padEnd(42, "e"))};

    let phase = 0;
    if (get().phase == undefined)
        set({phase});
    const execute = async (transaction, ...args) => {
        if (get().phase == phase++) {
            await web3Func(send, transaction, ...args);
            console.log(`phase ${phase} executed`);
            set({phase});
        }
    };

    const contractRegistry                = await web3Func(deploy, "contractRegistry"               , "ContractRegistry"               , []);
    const converterFactory                = await web3Func(deploy, "converterFactory"               , "ConverterFactory"               , []);
    const bancorFormula                   = await web3Func(deploy, "bancorFormula"                  , "BancorFormula"                  , []);
    const bancorNetwork                   = await web3Func(deploy, "bancorNetwork"                  , "BancorNetwork"                  , [contractRegistry._address]);
    const conversionPathFinder            = await web3Func(deploy, "conversionPathFinder"           , "ConversionPathFinder"           , [contractRegistry._address]);
    const converterUpgrader               = await web3Func(deploy, "converterUpgrader"              , "ConverterUpgrader"              , [contractRegistry._address, addresses.ETH]);
    const converterRegistry               = await web3Func(deploy, "converterRegistry"              , "ConverterRegistry"              , [contractRegistry._address]);
    const converterRegistryData           = await web3Func(deploy, "converterRegistryData"          , "ConverterRegistryData"          , [contractRegistry._address]);
    const liquidTokenConverterFactory     = await web3Func(deploy, "liquidTokenConverterFactory"    , "LiquidTokenConverterFactory"    , []);
    const liquidityPoolV1ConverterFactory = await web3Func(deploy, "liquidityPoolV1ConverterFactory", "LiquidityPoolV1ConverterFactory", []);

    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("ContractRegistry"           ), contractRegistry     ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("ConverterFactory"           ), converterFactory     ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BancorFormula"              ), bancorFormula        ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BancorNetwork"              ), bancorNetwork        ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("ConversionPathFinder"       ), conversionPathFinder ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BancorConverterUpgrader"    ), converterUpgrader    ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BancorConverterRegistry"    ), converterRegistry    ._address));
    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BancorConverterRegistryData"), converterRegistryData._address));
    await execute(converterFactory.methods.registerTypedConverterFactory(liquidTokenConverterFactory    ._address));
    await execute(converterFactory.methods.registerTypedConverterFactory(liquidityPoolV1ConverterFactory._address));

    for (const reserve of get().reserves) {
        const name     = reserve.symbol + " ERC20 Token";
        const symbol   = reserve.symbol;
        const decimals = reserve.decimals;
        const supply   = decimalToInteger(reserve.supply, decimals);
        const token    = await web3Func(deploy, "erc20Token" + symbol, "ERC20Token", [name, symbol, decimals, supply]);
        addresses[reserve.symbol] = token._address;
    }

    for (const converter of get().converters) {
        const name     = converter.symbol + " Smart Token";
        const symbol   = converter.symbol;
        const decimals = converter.decimals;
        const fee      = percentageToPPM(converter.fee);
        const type     = converter.reserves.length > 1 ? 1 : 0;
        const tokens   = converter.reserves.map(reserve => addresses[reserve.symbol]);
        const weights  = converter.reserves.map(reserve => percentageToPPM(reserve.weight));
        const amounts  = converter.reserves.map(reserve => decimalToInteger(reserve.balance, decimals));
        const value    = amounts[converter.reserves.findIndex(reserve => reserve.symbol == "ETH")];

        await execute(converterRegistry.methods.newConverter(type, name, symbol, decimals, fee, tokens, weights));
        const smartToken = deployed(web3, "SmartToken", (await converterRegistry.methods.getSmartTokens().call()).slice(-1)[0]);
        const converterBase = deployed(web3, "ConverterBase", await smartToken.methods.owner().call());
        await execute(converterBase.methods.acceptOwnership());

        if (type == 1 && amounts.every(amount => amount > 0)) {
            for (let i = 0; i < converter.reserves.length; i++) {
                if (converter.reserves.symbol != "ETH")
                    await execute(deployed(web3, "ERC20Token", tokens[i]).methods.approve(converterBase._address, amounts[i]));
            }
            await execute(deployed(web3, "LiquidityPoolV1Converter", converterBase._address).methods.addLiquidity(tokens, amounts, 1), value);
        }

        addresses[converter.symbol] = smartToken._address;
    }

    await execute(contractRegistry.methods.registerAddress(Web3.utils.asciiToHex("BNTToken"), addresses.BNT));
    await execute(conversionPathFinder.methods.setAnchorToken(addresses.BNT));

    if (web3.currentProvider.constructor.name == "WebsocketProvider")
        web3.currentProvider.connection.close();
}

run();