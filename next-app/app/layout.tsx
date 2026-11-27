import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ফাঁকা পাতা · উইকিসংকলন প্রুফরিডিং সহায়ক",
  description:
    "উইকিসংকলনের ফাঁকা পাতা খুঁজে দেখার, স্ক্যান যাচাই করার এবং লেখাবিহীন হিসেবে প্রুফ করার টুল।",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="bn">
      <body>{children}</body>
    </html>
  );
}
