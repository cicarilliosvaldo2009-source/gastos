import "./globals.css";

export const metadata = {
  title: "Panel de Gastos",
  description: "Control de gastos personal conectado a Mercado Pago",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Gastos",
  },
};

export const viewport = {
  themeColor: "#3F6659",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
