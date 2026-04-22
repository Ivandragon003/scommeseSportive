export const getErrorMessage = (error: unknown, fallback = 'Errore inatteso'): string => {
  if (!error) return fallback;

  const candidate = error as {
    message?: string;
    response?: {
      data?: {
        error?: string;
        message?: string;
      };
    };
  };

  return (
    candidate?.response?.data?.error ||
    candidate?.response?.data?.message ||
    candidate?.message ||
    fallback
  );
};
