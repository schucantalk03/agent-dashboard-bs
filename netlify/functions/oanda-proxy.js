exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { token, accountId, path } = JSON.parse(event.body);

    // OANDA demo account uses fxpractice endpoint
    const baseUrl = 'https://api-fxpractice.oanda.com/v3/accounts/' + accountId;

    const response = await fetch(baseUrl + path, {
      method: 'GET',
      headers: {
        'Authorization':  'Bearer ' + token,
        'Content-Type':   'application/json',
        'Accept-Datetime-Format': 'RFC3339',
      },
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
