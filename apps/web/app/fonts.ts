import localFont from 'next/font/local';

// The app's fonts, shadcn's Nova defaults, from files in the repository (the owner's choice,
// T17c), so no build fetches them: Geist's and Geist Mono's variable fonts from the font's own
// repository, vercel/geist-font, at tag v1.9.2, with their licence (fonts/OFL.txt). The root
// layout and global-error, which replaces it, both put these classes on <html>: they define the
// variables globals.css reads.
const geistSans = localFont({
  src: './fonts/Geist-Variable.woff2',
  weight: '100 900',
  variable: '--font-geist-sans',
});
const geistMono = localFont({
  src: './fonts/GeistMono-Variable.woff2',
  weight: '100 900',
  variable: '--font-geist-mono',
});

export const fontVariables = `${geistSans.variable} ${geistMono.variable}`;
