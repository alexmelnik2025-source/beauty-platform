import { Platform, Share } from 'react-native';
import type { CsvShareTools } from '../share';

/**
 * What this platform can do with the CSV: save the file in a browser, the share sheet on a phone.
 * Task 334: the same for the client's data as JSON (`application/json`).
 */
export function csvTools(type = 'text/csv;charset=utf-8'): CsvShareTools {
  if (Platform.OS !== 'web') {
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  return {
    download: (fileName, csv) => {
      const url = URL.createObjectURL(new Blob([csv], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
