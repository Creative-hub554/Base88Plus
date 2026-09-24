import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anybase — AI app builder for every model",
  description:
    "Build apps by chatting. Bring any AI provider: OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Ollama and more.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-neutral-950 text-neutral-200 antialiased">
        {children}
      </body>
    </html>
  );
}
