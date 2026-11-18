import { Geist, Geist_Mono } from 'next/font/google';

// The app's fonts, shadcn's Nova defaults. The root layout and global-error, which replaces it,
// both put these classes on <html>: they define the variables globals.css reads.
const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const fontVariables = `${geistSans.variable} ${geistMono.variable}`;
