import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, Heading, Pressable } from '../ui';

export type SalonChoice = {
  orgId: string;
  orgName: string;
  role: 'owner' | 'manager' | 'staff';
  locationId: string;
  locationName: string;
  city: string;
  /** ISO 4217: prices of this location are in hundredths of it. */
  currency: string;
};

/** The salons this person was invited to (several organizations or several locations). */
export function SalonsScreen(props: {
  t: Dictionary;
  choices: SalonChoice[];
  onChoose: (choice: SalonChoice) => void;
  /** Task 350: "Załóż salon" — shown to a person who has no salon yet. */
  onCreate: () => void;
  onSignOut: () => void;
}) {
  const { t } = props;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Heading>{t.salons.title}</Heading>
      {props.choices.length === 0 ? (
        <Card>
          <Text style={styles.name}>{t.salons.ownTitle}</Text>
          <Text style={styles.text}>{t.salons.ownLead}</Text>
          <View style={{ marginTop: 8 }}>
            <Button label={t.salons.create} onPress={props.onCreate} />
          </View>
        </Card>
      ) : null}
      {props.choices.length === 0 ? <Text style={styles.text}>{t.salons.none}</Text> : null}
      {props.choices.map((c) => {
        const details = `${c.orgName} · ${c.city} · ${t.salons.role[c.role]}`;
        const detailsId = `salon-details-${c.locationId}`;
        return (
          <Pressable
            key={c.locationId}
            accessibilityRole="button"
            accessibilityLabel={c.locationName}
            accessibilityHint={details}
            aria-describedby={detailsId}
            onPress={() => props.onChoose(c)}
            style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.name}>{c.locationName}</Text>
            <Text nativeID={detailsId} style={styles.text}>
              {details}
            </Text>
          </Pressable>
        );
      })}
      <Button kind="link" label={t.signOut} onPress={props.onSignOut} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  choice: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 4,
  },
  name: { fontSize: 18, fontWeight: '700', color: colors.ink },
  text: { color: colors.muted, fontSize: 15 },
});
