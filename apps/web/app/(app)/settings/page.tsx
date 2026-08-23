import { getSettings } from '@/lib/session';
import { SettingsForm } from '@/components/settings-form';

export default async function SettingsPage() {
  const settings = await getSettings();
  if (!settings) {
    return <div className="empty-state">Settings could not be loaded.</div>;
  }
  return <SettingsForm initial={settings} />;
}
