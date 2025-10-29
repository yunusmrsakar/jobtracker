// lib/google.ts
import { google } from 'googleapis';

export const GMAIL_SCOPE = ['https://www.googleapis.com/auth/gmail.readonly'];
export const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!;

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    REDIRECT_URI
  );
}
