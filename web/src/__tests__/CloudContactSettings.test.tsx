import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../api";
import { CloudContactSettings } from "../CloudContactSettings";

vi.mock("../api", () => ({
  confirmCloudContactVerification: vi.fn(),
  fetchCloudContactStatus: vi.fn(),
  revokeCloudContact: vi.fn(),
  startCloudContactVerification: vi.fn(),
  UnsupportedCloudContactError: class UnsupportedCloudContactError extends Error {},
}));

const emptyStatus: api.CloudContactStatus = {
  email: null,
  latestDelivery: null,
  pendingExpiresAtEpoch: null,
  enrolmentAvailable: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchCloudContactStatus).mockResolvedValue(emptyStatus);
  window.history.replaceState(null, "", "/cloud");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/cloud");
});

describe("CloudContactSettings", () => {
  it("asks for a verification link without disclosing whether the address is usable", async () => {
    render(<CloudContactSettings />);
    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "person@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send verification link" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "If this address can be used, a verification message will arrive shortly.",
    );
    expect(api.startCloudContactVerification).toHaveBeenCalledWith(
      "person@example.test",
      expect.any(String),
    );
  });

  it("removes the callback token from browser history before posting it", async () => {
    const token = "a".repeat(64);
    window.history.replaceState(null, "", `/cloud#contact_token=${token}`);
    vi.mocked(api.confirmCloudContactVerification).mockResolvedValue(true);

    render(<CloudContactSettings />);

    await waitFor(() => expect(api.confirmCloudContactVerification).toHaveBeenCalledWith(token));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(token);
    expect(await screen.findByRole("status")).toHaveTextContent("Email address verified.");
  });

  it("loads contact status after confirmation without a stale request racing it", async () => {
    let resolveConfirmation!: (verified: boolean) => void;
    vi.mocked(api.confirmCloudContactVerification).mockReturnValue(new Promise((resolve) => {
      resolveConfirmation = resolve;
    }));
    const verifiedStatus: api.CloudContactStatus = {
      email: {
        contactId: "contact-verified",
        maskedDestination: "p***@example.test",
        verifiedAtEpoch: 1_800_000_000,
      },
      latestDelivery: null,
      pendingExpiresAtEpoch: null,
      enrolmentAvailable: true,
    };
    vi.mocked(api.fetchCloudContactStatus).mockResolvedValue(verifiedStatus);
    window.history.replaceState(null, "", `/cloud#contact_token=${"b".repeat(64)}`);

    render(<CloudContactSettings />);

    expect(api.fetchCloudContactStatus).not.toHaveBeenCalled();
    resolveConfirmation(true);

    expect(await screen.findByText("p***@example.test")).toBeInTheDocument();
    expect(api.fetchCloudContactStatus).toHaveBeenCalledOnce();
  });

  it("does not leave a failed initial status request looking like it is still loading", async () => {
    vi.mocked(api.fetchCloudContactStatus).mockRejectedValue(new Error("network unavailable"));

    render(<CloudContactSettings />);

    expect(await screen.findByText("Contact settings could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Checking contact settings…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("can revoke an existing verified contact", async () => {
    vi.mocked(api.fetchCloudContactStatus).mockResolvedValue({
      email: {
        contactId: "contact-1",
        maskedDestination: "p***@example.test",
        verifiedAtEpoch: 1_800_000_000,
      },
      latestDelivery: null,
      pendingExpiresAtEpoch: null,
      enrolmentAvailable: true,
    });
    render(<CloudContactSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove verified email" }));
    await waitFor(() => expect(api.revokeCloudContact).toHaveBeenCalledOnce());
  });

  describe("retrying a failed status load", () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function renderFailedLoad() {
      vi.mocked(api.fetchCloudContactStatus).mockRejectedValueOnce(new Error("initial failure"));
      render(<CloudContactSettings />);
      await screen.findByText("Contact settings could not be loaded.");
      expect(api.fetchCloudContactStatus).toHaveBeenCalledTimes(1);
    }

    it("shows a pending retry and ignores repeated activation", async () => {
      await renderFailedLoad();
      const pending = deferred<api.CloudContactStatus>();
      vi.mocked(api.fetchCloudContactStatus).mockReturnValueOnce(pending.promise);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const retrying = await screen.findByRole("button", { name: "Retrying…" });
      expect(retrying).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      fireEvent.click(retrying);
      fireEvent.click(retrying);
      expect(api.fetchCloudContactStatus).toHaveBeenCalledTimes(2);

      pending.resolve(emptyStatus);
      expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
      expect(screen.queryByText("Contact settings could not be loaded.")).not.toBeInTheDocument();
      expect(api.fetchCloudContactStatus).toHaveBeenCalledTimes(2);
    });

    it("shows the retry error and re-enables Retry after another failure", async () => {
      await renderFailedLoad();
      const pending = deferred<api.CloudContactStatus>();
      vi.mocked(api.fetchCloudContactStatus).mockReturnValueOnce(pending.promise);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("button", { name: "Retrying…" });
      pending.reject(new Error("still unavailable"));

      expect(await screen.findByRole("alert")).toHaveTextContent("still unavailable");
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toBeEnabled();
      expect(api.fetchCloudContactStatus).toHaveBeenCalledTimes(2);

      vi.mocked(api.fetchCloudContactStatus).mockResolvedValueOnce(emptyStatus);
      fireEvent.click(retry);

      expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(api.fetchCloudContactStatus).toHaveBeenCalledTimes(3);
    });

    it("does not start verification, confirmation or removal while retrying", async () => {
      await renderFailedLoad();
      vi.mocked(api.fetchCloudContactStatus).mockResolvedValueOnce(emptyStatus);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByLabelText("Email address");

      expect(api.startCloudContactVerification).not.toHaveBeenCalled();
      expect(api.confirmCloudContactVerification).not.toHaveBeenCalled();
      expect(api.revokeCloudContact).not.toHaveBeenCalled();
    });
  });

  it("explains that older servers do not support contact settings", async () => {
    vi.mocked(api.fetchCloudContactStatus).mockRejectedValue(new api.UnsupportedCloudContactError());
    render(<CloudContactSettings />);

    expect(await screen.findByText("Email contact settings require a newer Sotto server version.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send verification link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows only a safe delivery summary without exposing provider identifiers", async () => {
    vi.mocked(api.fetchCloudContactStatus).mockResolvedValue({
      email: null,
      latestDelivery: { state: "suppressed", updatedAtEpoch: 1_800_000_000 },
      pendingExpiresAtEpoch: null,
      enrolmentAvailable: true,
    });
    render(<CloudContactSettings />);

    expect(await screen.findByText(
      "Email delivery is paused because the address could not accept a previous message.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/provider-message|@example\.test/)).not.toBeInTheDocument();
  });
});
