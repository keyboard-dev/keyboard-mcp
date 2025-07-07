import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';


async function getAccessToken() {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_CLOUD_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function callWorkstationAPI() {
  const token = await getAccessToken();
  //   const response = await axios.post(
//     `${process.env.WORKSTATION_HOST}/api/run`,
//     { input: 'Hello from backend!' },
//     {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'Content-Type': 'application/json',
//       },
//     }
//   );

//   }

callWorkstationAPI().catch(console.error);