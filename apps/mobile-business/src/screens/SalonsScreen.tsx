import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Dictionary } from '../i18n';
import { Button, Card, colors, Heading } from '../ui';

export type SalonChoice = {
  orgId: string;
  orgName: string;
  role: 'owner' | 'manager' | 'staff';
  locationId: string;
  locationName: string;
  city: string;
};

/** The salons this person was invited to (several organizations or several locations). */
export function SalonsScreen(props: {
  t: Dictionary;
  choices: SalonChoice[];
  onChoose: (choice: SalonChoice) => void;
  onSignOut: () => void;
}) {
  const { t } = props;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Heading>{t.salons.title}</Heading>
      {props.choices.length === 0 ? <Text style={styles.text}>{t.salons.none}</Text> : null}
      {props.choices.map((c) => (
        <Card key={c.locationId}>
          <Text style={styles.name}>{c.locationName}</Text>
          <Text style={styles.text}>
            {c.orgName} · {c.city} · {t.salons.role[c.role]}
          </Text>
          <View style={{ marginTop: 8 }}>
            <Button kind="secondary" label={c.locationName} onPress={() => props.onChoose(c)} />
          </View>
        </Card>
      ))}
      <Button kind="link" label={t.signOut} onPress={props.onSignOut} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 14 },
  name: { fontSize: 18, fontWeight: '700', color: colors.ink },
  text: { color: colors.muted, fontSize: 15 },
});
