import "./globals.css";

export const metadata = {
  title: "Panel de Gastos",
  description: "Control de gastos personal conectado a Mercado Pago",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
