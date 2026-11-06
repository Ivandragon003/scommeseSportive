import WalletArchivePage from '../wallets/WalletArchivePage';
import PaperWalletPage from '../wallets/PaperWalletPages';

export default function PredictionArchivePage() {
  return <PaperWalletPage kind="archive" legacy={<WalletArchivePage />} />;
}
