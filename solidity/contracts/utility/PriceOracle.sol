pragma solidity 0.4.26;
import "./Utils.sol";
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
    IERC20Token public tokenA;                  // token A the oracle supports
    IERC20Token public tokenB;                  // token B the oracle supports
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
        validAddresses(_tokenA, _tokenB)
        validAddresses(_tokenAOracle, _tokenBOracle)
    {
        tokenA = _tokenA;
        tokenB = _tokenB;
        tokenAOracle = _tokenAOracle;
        tokenBOracle = _tokenBOracle;
        tokensToOracles[_tokenA] = _tokenAOracle;
        tokensToOracles[_tokenB] = _tokenBOracle;
    }

    // ensures that the provided addresses are valid
    modifier validAddresses(address _address1, address _address2) {
        _validAddresses(_address1, _address2);
        _;
    }

    // error message binary size optimization
    function _validAddresses(address _address1, address _address2) internal pure {
        _validAddress(_address1);
        _validAddress(_address2);
        require(_address1 != _address2, "ERR_SAME_ADDRESS");
    }

    // ensures that the provides tokens are supported by the oracle
    modifier supportedTokens(IERC20Token _tokenA, IERC20Token _tokenB) {
        _supportedTokens(_tokenA, _tokenB);
        _;
    }

    // error message binary size optimization
    function _supportedTokens(IERC20Token _tokenA, IERC20Token _tokenB) internal view {
        require(_tokenA != _tokenB, "ERR_SAME_ADDRESS");
        require(tokensToOracles[_tokenA] != address(0) && tokensToOracles[_tokenB] != address(0), "ERR_UNSUPPORTED_TOKEN");
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
        supportedTokens(_tokenA, _tokenB)
        returns (uint256, uint256)
    {
        return (uint256(tokensToOracles[_tokenA].latestAnswer()), uint256(tokensToOracles[_tokenB].latestAnswer()));
    }

    /**
      * @dev returns the timestamp of the last price update the rates are returned as numerator (token1) and denominator
      * (token2) for accuracy
      *
      * @return timestamp
    */
    function lastUpdateTime()
        public
        view
        returns (uint256) {
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
    function latestRateAndUpdateTime(IERC20Token _tokenA, IERC20Token _tokenB)
        public
        view
        returns (uint256, uint256, uint256)
    {
        (uint256 numerator, uint256 denominator) = latestRate(_tokenA, _tokenB);

        return (numerator, denominator, lastUpdateTime());
    }
}
