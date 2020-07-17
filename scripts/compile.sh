#!/bin/bash
solc="docker run -v $HOME/git/contracts-solidity/solidity:/solidity ethereum/solc:0.4.26"
CONTRACTS_PATH=../solidity/contracts
OUTPUT_PATH=../solidity/build
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/BancorNetwork.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/ConversionPathFinder.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/bancorx/BancorX.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/bancorx/XTransferRerouter.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/LiquidTokenConverter.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/LiquidityPoolV1Converter.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/LiquidityPoolV2Converter.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/PoolTokensContainer.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/ConverterFactory.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/ConverterRegistry.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/ConverterRegistryData.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/ConverterUpgrader.sol
$solc --optimize --optimize-runs 20000 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/converter/BancorFormula.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/token/EtherToken.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/token/SmartToken.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/utility/ContractRegistry.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/utility/PriceOracle.sol
$solc --optimize --optimize-runs 200 --abi --bin --allow-paths $CONTRACTS_PATH, -o $OUTPUT_PATH --overwrite $CONTRACTS_PATH/utility/Whitelist.sol
