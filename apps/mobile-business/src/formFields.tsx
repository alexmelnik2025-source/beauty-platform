import type { ReactNode } from 'react';
import { TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, ErrorText } from './ui';

export function FieldError({ message }: { message?: string }) {
  return message ? <ErrorText>! {message}</ErrorText> : null;
}

export function FormField({
  error,
  containerStyle,
  style,
  ...input
}: TextInputProps & { error?: string; containerStyle?: StyleProp<ViewStyle> }) {
  return (
    <View style={containerStyle}>
      <TextInput
        {...input}
        aria-invalid={!!error}
        style={[style, error && { borderColor: colors.danger }]}
      />
      <FieldError message={error} />
    </View>
  );
}

export function FieldGroup({ error, children }: { error?: string; children: ReactNode }) {
  return (
    <View
      style={
        error
          ? { borderWidth: 1, borderColor: colors.danger, borderRadius: 12, padding: 8 }
          : undefined
      }
    >
      {children}
      <FieldError message={error} />
    </View>
  );
}
