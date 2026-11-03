import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WalletProvider } from "./wallet/WalletProvider";
import { SocialAuthProvider } from "./social/SocialAuthProvider";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <SocialAuthProvider>
          <App />
        </SocialAuthProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
