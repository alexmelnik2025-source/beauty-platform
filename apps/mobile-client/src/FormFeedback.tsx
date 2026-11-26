import { memo } from 'react';
import { View } from 'react-native';
import type { FormFailure } from './errors';
import { Button, colors, ErrorText } from './ui';

export const FormFeedback = memo(function FormFeedback(props: {
  failure: FormFailure | null;
  retryLabel: string;
  busy?: boolean;
}) {
  const { failure, retryLabel, busy } = props;
  if (!failure) return null;
  return (
    <View style={{ gap: 4 }}>
      <ErrorText>{failure.message}</ErrorText>
      {failure.retry ? (
        <Button kind="secondary" label={retryLabel} onPress={failure.retry} disabled={busy} />
      ) : null}
    </View>
  );
});

export function FieldGroup(props: { error?: string; children: React.ReactNode }) {
  return (
    <View
      style={
        props.error
          ? { gap: 4, borderColor: colors.danger, borderWidth: 1, borderRadius: 10, padding: 4 }
          : undefined
      }
    >
      {props.children}
      {props.error ? <ErrorText>! {props.error}</ErrorText> : null}
    </View>
  );
}
