import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { BrowserProvider } from "ethers";
import type { Eip1193Provider } from "ethers";
import { EXPECTED_CHAIN, EXPECTED_CHAIN_ID } from "../config/chains";
import { getMetaMaskProvider } from "./eip1193";
import type { Eip1193Provider as WalletEip1193 } from "./eip1193";
import { WalletContext } from "./walletContext";
import type { WalletContextValue, WalletStatus } from "./walletContext";

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [injected, setInjected] = useState<WalletEip1193 | null>(() =>
    typeof window === "undefined" ? null : getMetaMaskProvider(),
  );
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = useMemo(
    () => (injected ? new BrowserProvider(injected as Eip1193Provider) : null),
    [injected],
  );

  const refreshAccounts = useCallback(async (accounts: string[]) => {
    setAccount(accounts.length > 0 ? accounts[0] : null);
  }, []);

  const refreshChain = useCallback(async (hexChainId: string) => {
    const id = Number.parseInt(hexChainId, 16);
    setChainId(Number.isNaN(id) ? null : id);
  }, []);

  // Silent restore + event listeners. Runs once per injected provider.
  useEffect(() => {
    if (!injected) {
      // A wallet may finish injecting after first paint; re-check once.
      const onInit = () => setInjected(getMetaMaskProvider());
      window.addEventListener("ethereum#initialized", onInit, { once: true });
      return () => window.removeEventListener("ethereum#initialized", onInit);
    }

    let cancelled = false;

    injected
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (!cancelled) void refreshAccounts(accounts as string[]);
      })
      .catch(() => undefined);
    injected
      .request({ method: "eth_chainId" })
      .then((hex) => {
        if (!cancelled) void refreshChain(hex as string);
      })
      .catch(() => undefined);

    const onAccountsChanged = (...args: never[]) =>
      void refreshAccounts(args[0] as string[]);
    const onChainChanged = (...args: never[]) =>
      void refreshChain(args[0] as string);

    injected.on("accountsChanged", onAccountsChanged);
    injected.on("chainChanged", onChainChanged);

    return () => {
      cancelled = true;
      injected.removeListener("accountsChanged", onAccountsChanged);
      injected.removeListener("chainChanged", onChainChanged);
    };
  }, [injected, refreshAccounts, refreshChain]);

  const switchToExpectedChain = useCallback(async () => {
    if (!injected) throw new Error("MetaMask is not installed.");
    setError(null);
    try {
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: EXPECTED_CHAIN.addChainParams.chainId }],
      });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902) {
        // Chain unknown to this wallet: add it, then switch.
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [EXPECTED_CHAIN.addChainParams],
        });
      } else if (code === 4001) {
        setError("Network switch was rejected in MetaMask.");
        return;
      } else {
        setError((err as Error)?.message ?? "Failed to switch network.");
        return;
      }
    }
    // chainId state updates through the chainChanged listener.
  }, [injected]);

  const connect = useCallback(async () => {
    if (!injected) {
      setError("MetaMask is not installed.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await injected.request({
        method: "eth_requestAccounts",
      })) as string[];
      await refreshAccounts(accounts);

      const hex = (await injected.request({ method: "eth_chainId" })) as string;
      await refreshChain(hex);
      if (Number.parseInt(hex, 16) !== EXPECTED_CHAIN_ID) {
        // Wrong network: nudge the wallet onto the expected chain automatically.
        await switchToExpectedChain();
      }
    } catch (err) {
      const code = (err as { code?: number })?.code;
      setError(
        code === 4001
          ? "Connection request was rejected in MetaMask."
          : ((err as Error)?.message ?? "Failed to connect wallet."),
      );
    } finally {
      setConnecting(false);
    }
  }, [injected, refreshAccounts, refreshChain, switchToExpectedChain]);

  const disconnect = useCallback(() => {
    setAccount(null);
  }, []);

  const status: WalletStatus = !injected
    ? "no-provider"
    : connecting
      ? "connecting"
      : account
        ? "connected"
        : "disconnected";

  const value: WalletContextValue = {
    status,
    account,
    chainId,
    isExpectedChain: chainId === EXPECTED_CHAIN_ID,
    provider,
    error,
    connect,
    switchToExpectedChain,
    disconnect,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
