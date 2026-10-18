const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  InitiateAuthCommand,
  GetUserCommand,
  UpdateUserAttributesCommand,
  AdminUpdateUserAttributesCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const config = require('../config');

const client = new CognitoIdentityProviderClient({
  region: config.COGNITO_REGION
});

/**
 * Register a new user in Cognito with name, tone, and system prompt.
 */
async function signUp({ email, password, name = '', tone = 'friendly', customPrompt = '' }) {
  const userAttributes = [
    { Name: 'name', Value: name || email.split('@')[0] },
    { Name: 'custom:tone', Value: tone || 'friendly' }
  ];

  if (customPrompt) {
    userAttributes.push({ Name: 'custom:custom_prompt', Value: customPrompt });
  }

  const signUpResult = await client.send(
    new SignUpCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: userAttributes
    })
  );

  // Auto-confirm via admin to allow immediate login without email sandbox limits
  try {
    await client.send(
      new AdminConfirmSignUpCommand({
        UserPoolId: config.COGNITO_USER_POOL_ID,
        Username: email
      })
    );
  } catch (err) {
    console.warn('[Cognito] AdminConfirmSignUp skipped/failed:', err.message);
  }

  return {
    userSub: signUpResult.UserSub,
    isConfirmed: true
  };
}

/**
 * Confirm a user registration using email verification code
 */
async function confirmSignUp({ email, code }) {
  const { ConfirmSignUpCommand } = require('@aws-sdk/client-cognito-identity-provider');
  return await client.send(
    new ConfirmSignUpCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code
    })
  );
}

/**
 * Authenticate with Cognito using email and password
 */
async function login({ email, password }) {
  const authRes = await client.send(
    new InitiateAuthCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password
      }
    })
  );

  const authResult = authRes.AuthenticationResult;
  if (!authResult) {
    throw new Error('Authentication challenge required or unexpected auth result.');
  }

  // Fetch user profile immediately
  const userDetails = await getUser(authResult.AccessToken);

  return {
    accessToken: authResult.AccessToken,
    idToken: authResult.IdToken,
    refreshToken: authResult.RefreshToken,
    expiresIn: authResult.ExpiresIn,
    user: userDetails
  };
}

/**
 * Retrieve user profile attributes from Cognito using AccessToken
 */
async function getUser(accessToken) {
  const userRes = await client.send(
    new GetUserCommand({
      AccessToken: accessToken
    })
  );

  const attributes = {};
  for (const attr of userRes.UserAttributes || []) {
    if (attr.Name === 'custom:tone') {
      attributes.tone = attr.Value;
    } else if (attr.Name === 'custom:custom_prompt') {
      attributes.customPrompt = attr.Value;
    } else {
      attributes[attr.Name] = attr.Value;
    }
  }

  return {
    id: attributes.sub || userRes.Username,
    username: userRes.Username,
    email: attributes.email || userRes.Username,
    name: attributes.name || '',
    tone: attributes.tone || 'friendly',
    customPrompt: attributes.customPrompt || ''
  };
}

/**
 * Update user attributes (name, tone, system prompt) in Cognito
 */
async function updateUser(accessToken, { name, tone, customPrompt }) {
  const userAttributes = [];
  if (name !== undefined) userAttributes.push({ Name: 'name', Value: name });
  if (tone !== undefined) userAttributes.push({ Name: 'custom:tone', Value: tone });
  if (customPrompt !== undefined) userAttributes.push({ Name: 'custom:custom_prompt', Value: customPrompt });

  if (userAttributes.length === 0) return;

  await client.send(
    new UpdateUserAttributesCommand({
      AccessToken: accessToken,
      UserAttributes: userAttributes
    })
  );

  return await getUser(accessToken);
}

module.exports = {
  signUp,
  confirmSignUp,
  login,
  getUser,
  updateUser
};
