const { getExchangeRates } = require('../src/utils/currencyConvert');

getExchangeRates()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
