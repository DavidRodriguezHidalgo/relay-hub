import type { RelayApi } from '@relay/shared';

declare global {
  interface Window {
    relay: RelayApi;
  }
}
