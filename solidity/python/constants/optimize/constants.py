PRECISION = 127


LOG_MAX_HI_TERM_VAL = 1 # The input to function 'log' must be smaller than e ^ LOG_MAX_HI_TERM_VAL
LOG_NUM_OF_HI_TERMS = 8 # Compute e ^ (LOG_MAX_HI_TERM_VAL / 2 ^ n) for n = 0 to LOG_NUM_OF_HI_TERMS


EXP_MAX_HI_TERM_VAL = 3 # The input to function 'exp' must be smaller than 2 ^ EXP_MAX_HI_TERM_VAL
EXP_NUM_OF_HI_TERMS = 6 # Compute e ^ 2 ^ (n - EXP_MAX_HI_TERM_VAL) for n = 0 to EXP_MAX_HI_TERM_VAL
