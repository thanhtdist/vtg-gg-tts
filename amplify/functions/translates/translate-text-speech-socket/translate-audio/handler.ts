import AWS from 'aws-sdk';
import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { Config } from '@configs/config';
import jwt from 'jsonwebtoken';

const dynamoDB = new AWS.DynamoDB.DocumentClient({ region: Config.region });
const translate = new AWS.Translate({ region: Config.region });
const polly = new AWS.Polly({ region: Config.region });

// Add 'vi' here to enable Vietnamese listener support.
// Polly does not support Vietnamese, so 'vi' is handled by Google Cloud TTS below.
const languages = ['en-US', 'zh', 'vi'];

// --- Polly helpers (unchanged, used for all languages except 'vi') ---

const getVoiceId = (lang: string): string => {
  switch (lang) {
    case 'ja-JP': return 'Mizuki';
    case 'en-US': return 'Joanna';
    case 'ko-KR': return 'Seoyeon';
    case 'zh':
    case 'zh-TW': return 'Zhiyu';
    default: return 'Joanna';
  }
};

const getSpeechParams = (text: string, voiceId: string, lang: string): AWS.Polly.SynthesizeSpeechInput => {
  const params: AWS.Polly.SynthesizeSpeechInput = {
    Engine: 'standard',
    OutputFormat: 'mp3',
    Text: text,
    VoiceId: voiceId,
  };
  if (lang === 'zh') {
    params.LanguageCode = 'cmn-CN';
  }
  return params;
};

// --- Google Cloud TTS (used only for 'vi') ---
//
// Credential source (set ONE of these Lambda env vars):
//   Dev  → GOOGLE_APPLICATION_CREDENTIALS_JSON  (service account JSON as string)
//   Prod → GOOGLE_TTS_SECRET_NAME               (AWS Secrets Manager secret name)
//
// The TTS logic (JWT → OAuth2 token → API call) is identical in both cases.

interface GoogleCredentials {
  client_email: string;
  private_key: string;
}

const getGoogleCredentials = async (): Promise<GoogleCredentials | null> => {
  // Prod: fetch from AWS Secrets Manager
  const secretName = process.env.GOOGLE_TTS_SECRET_NAME;
  if (secretName) {
    const sm = new AWS.SecretsManager({ region: Config.region });
    const secret = await sm.getSecretValue({ SecretId: secretName }).promise();
    return JSON.parse(secret.SecretString || '{}');
  }

  // Dev: service account JSON as env var
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credentialsJson) {
    return JSON.parse(credentialsJson);
  }

  // Local quick test: API Key (no Service Account needed)
  return null;
};

const getGoogleAccessToken = async (credentials: GoogleCredentials): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const signedJwt = jwt.sign(
    {
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    },
    credentials.private_key,
    { algorithm: 'RS256' }
  );

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });
  const data = await response.json() as { access_token: string };
  return data.access_token;
};

const synthesizeVietnameseSpeech = async (text: string): Promise<Buffer> => {
  const credentials = await getGoogleCredentials();

  // Local quick test: API Key path
  if (!credentials) {
    const apiKey = process.env.GOOGLE_TTS_API_KEY;
    if (!apiKey) {
      throw new Error('Google TTS credentials not configured. Set GOOGLE_TTS_SECRET_NAME (prod), GOOGLE_APPLICATION_CREDENTIALS_JSON (dev), or GOOGLE_TTS_API_KEY (local).');
    }
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'vi-VN', name: 'vi-VN-Wavenet-A' },
          audioConfig: { audioEncoding: 'MP3' },
        }),
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google TTS API error ${response.status}: ${errText}`);
    }
    const data = await response.json() as { audioContent: string };
    return Buffer.from(data.audioContent, 'base64');
  }

  // Dev / Prod: Service Account path
  const accessToken = await getGoogleAccessToken(credentials);
  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'vi-VN', name: 'vi-VN-Wavenet-A' },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google TTS API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as { audioContent: string };
  return Buffer.from(data.audioContent, 'base64');
};

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { inputText, sourceLanguageCode, tourId } = body;

    if (!inputText || !sourceLanguageCode || !tourId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'tourId, inputText and sourceLanguageCode are required.' }),
        headers: Config.headers,
      };
    }

    // const connections = await dynamoDB.scan({
    //   TableName: Config.dbTables.WEBSOCKETCONNECTIONS,
    // }).promise();
    // Query connections with the given tourId
    const connections = await dynamoDB.query({
      TableName: Config.dbTables.WEBSOCKETCONNECTIONS,
      IndexName: 'tourId-index', // Make sure this GSI exists
      KeyConditionExpression: 'tourId = :tourId',
      ExpressionAttributeValues: {
        ':tourId': tourId,
      },
    }).promise();

    const apiGateway = new AWS.ApiGatewayManagementApi({
      apiVersion: '2018-11-29',
      endpoint: `${event.requestContext.domainName}/${event.requestContext.stage}`,
    });

    await Promise.all(languages.map(async (lang) => {
      try {
        // Amazon Translate uses 'vi' for Vietnamese, 'zh' for Simplified Chinese
        const translated = await translate.translateText({
          Text: inputText,
          SourceLanguageCode: sourceLanguageCode,
          TargetLanguageCode: lang,
        }).promise();

        const translatedText = translated.TranslatedText || '';

        // Route TTS: Google Cloud TTS for Vietnamese, Polly for all other languages
        let audioBase64: string;
        if (lang === 'vi') {
          const audioBuffer = await synthesizeVietnameseSpeech(translatedText);
          audioBase64 = audioBuffer.toString('base64');
        } else {
          const voiceId = getVoiceId(lang);
          const speechParams = getSpeechParams(translatedText, voiceId, lang);
          const speech = await polly.synthesizeSpeech(speechParams).promise();
          if (!speech.AudioStream || !(speech.AudioStream instanceof Buffer)) {
            console.warn(`❌ Invalid AudioStream for lang ${lang}`);
            return;
          }
          audioBase64 = speech.AudioStream.toString('base64');
        }

        const listeners = (connections.Items || []).filter(conn => conn.languageCode === lang);

        await Promise.all(listeners.map(async (listener) => {
          await apiGateway.postToConnection({
            ConnectionId: listener.connectionId,
            Data: JSON.stringify({
              type: 'translationWithAudio',
              language: lang,
              originalText: inputText,
              translatedText,
              audioBase64,
            }),
          }).promise();
        }));
      } catch (err) {
        console.error(`❌ Error processing language: ${lang}`, err);
      }
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Translation and audio sent successfully.',
      }),
      headers: Config.headers,
    };

  } catch (error: any) {
    console.error('❌ WebSocket handler error:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Internal Server Error' }),
      headers: Config.headers,
    };
  }
};
