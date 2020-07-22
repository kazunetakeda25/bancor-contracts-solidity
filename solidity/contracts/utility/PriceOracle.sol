pragma solidity 0.4.26;
import "./Utils.sol";
import "./SafeMath.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/IChainlinkPriceOracle.sol";

/**
  * @dev Provides the off-chain rate between two tokens
  *
  * The price oracle uses chainlink oracles internally to get the rates of the two tokens
  * with respect to a common denominator, and then returns the rate between them, which
  * is equivalent to the rate of TokenA / TokenB
*/
contract PriceOracle is IPriceOracle, Utils {
    using SafeMath for uint256;

    IERC20Token public tokenA;                  // token A the oracle supports
    IERC20Token public tokenB;                  // token B the oracle supports;
    mapping (address => uint8) public tokenDecimals; // token -> token decimals

    IChainlinkPriceOracle public tokenAOracle;  // token A chainlink price oracle
    IChainlinkPriceOracle public tokenBOracle;  // token B chainlink price oracle
    mapping (address => IChainlinkPriceOracle) public tokensToOracles;  // token -> price oracle for easier access

    /**
      * @dev initializes a new PriceOracle instance
      * note that the oracles must have the same common denominator (USD, ETH etc.)
      *
      * @param  _tokenA         first token to support
      * @param  _tokenB         second token to support
      * @param  _tokenAOracle   first token price oracle
      * @param  _tokenBOracle   second token price oracle
    */
    constructor(IERC20Token _tokenA, IERC20Token _tokenB, IChainlinkPriceOracle _tokenAOracle, IChainlinkPriceOracle _tokenBOracle)
        public
        validAddress(_tokenA)
        validAddress(_tokenB)
        validAddress(_tokenAOracle)
        validAddress(_tokenBOracle)
    {
        // validate the oracle interface
        _tokenAOracle.latestAnswer();
        _tokenBOracle.latestAnswer();
        _tokenAOracle.latestTimestamp();
        _tokenBOracle.latestTimestamp();

        tokenA = _tokenA;
        tokenB = _tokenB;
        tokenDecimals[_tokenA] = _tokenA.decimals();
        tokenDecimals[_tokenB] = _tokenB.decimals();

        tokenAOracle = _tokenAOracle;
        tokenBOracle = _tokenBOracle;
        tokensToOracles[_tokenA] = _tokenAOracle;
        tokensToOracles[_tokenB] = _tokenBOracle;
    }

    // ensures that the token is supported by the oracle
    modifier supportedToken(IERC20Token _token) {
        _supportedToken(_token);
        _;
    }

    // error message binary size optimization
    function _supportedToken(IERC20Token _token) internal view {
        require(tokensToOracles[_token] != address(0), "ERR_UNSUPPORTED_TOKEN");
    }

    /**
      * @dev returns the latest known rate between the two given tokens
      * for a given pair of tokens A and B, returns the rate of A / B
      * (the number of B units equivalent to a single A unit)
      * the rate is returned as a fraction (numerator / denominator) for accuracy
      *
      * @param  _tokenA token to get the rate of 1 unit of
      * @param  _tokenB token to get the rate of 1 `_tokenA` against
      *
      * @return numerator
      * @return denominator
    */
    function latestRate(IERC20Token _tokenA, IERC20Token _tokenB)
        public
        view
        supportedToken(_tokenA)
        supportedToken(_tokenB)
        returns (uint256, uint256)
    {
        uint256 rateTokenA = uint256(tokensToOracles[_tokenA].latestAnswer());
        uint256 rateTokenB = uint256(tokensToOracles[_tokenB].latestAnswer());
        uint8 decimalsTokenA = tokenDecimals[_tokenA];
        uint8 decimalsTokenB = tokenDecimals[_tokenB];

        // since the tokens can differ in their decimals and ChainLink returns the rate per the smallest token unit, we'd
        // have to normalize the rate.
        if (decimalsTokenA == decimalsTokenB) {
            return (rateTokenA, rateTokenB);
        }

        // the normalization works as follows:
        //   - token A with decimals of dA and price of rateA per one token (e.g., for 10^dA weiA)
        //   - token B with decimals of dB < dA and price of rateB per one token (e.g., for 10^dB weiB)
        // then the normalized rate, representing the rate between 1 weiA and 1 weiB is: rateA / (rateB * 10^(dA - dB)).
        //   - token A with decimals of 5 and price of $10 per one token (e.g., for 100,000 weiA)
        //   - token B with decimals of 2 and price of $2 per one token (e.g., for 100 weiB)
        // then the normalized rate would be: 5 / (2 * 10^3) = 0.0025, which is the correct rate since 1 weiA costs $0.00005,
        // 1 webB costs $0.02, and weiA / weiB is 0.0025.

        if (decimalsTokenA > decimalsTokenB) {
            rateTokenB = rateTokenB.mul(10 ** uint256((decimalsTokenA - decimalsTokenB)));
        } else {
            rateTokenA = rateTokenA.mul(10 ** uint256((decimalsTokenB - decimalsTokenA)));
        }

        return (rateTokenA, rateTokenB);
    }

    /**
      * @dev returns the timestamp of the last price update the rates are returned as numerator (token1) and denominator
      * (token2) for accuracy
      *
      * @return timestamp
    */
    function lastUpdateTime() public view returns (uint256) {
        // returns the oldest timestamp between the two
        uint256 timestampA = tokenAOracle.latestTimestamp();
        uint256 timestampB = tokenBOracle.latestTimestamp();

        return  timestampA < timestampB ? timestampA : timestampB;
    }

    /**
      * @dev returns both the rate and the timestamp of the last update in a single call (gas optimization)
      *
      * @param  _tokenA token to get the rate of 1 unit of
      * @param  _tokenB token to get the rate of 1 `_tokenA` against
      *
      * @return numerator
      * @return denominator
      * @return timestamp of the last update
    */
    function latestRateAndUpdateTime(IERC20Token _tokenA, IERC20Token _tokenB) public view returns (uint256, uint256, uint256) {
        (uint256 numerator, uint256 denominator) = latestRate(_tokenA, _tokenB);

        return (numerator, denominator, lastUpdateTime());
    }
}
