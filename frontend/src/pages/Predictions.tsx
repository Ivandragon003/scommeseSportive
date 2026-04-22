import React from 'react';
import PredictionWorkbenchView from '../components/predictions/PredictionWorkbenchView';
import ToastStack from '../components/common/ToastStack';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { usePredictionWorkbench } from '../hooks/usePredictionWorkbench';

interface PredictionsProps {
  activeUser: string;
}

const Predictions: React.FC<PredictionsProps> = ({ activeUser }) => {
  const vm = usePredictionWorkbench(activeUser);

  return (
    <>
      <PredictionWorkbenchView vm={vm} />
      <ToastStack toasts={vm.toastState.toasts} onDismiss={vm.toastState.dismissToast} />
      <ConfirmDialog {...vm.confirmDialog.dialogProps} />
    </>
  );
};

export default Predictions;
