import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import * as probe from 'libcaptureprobe.so';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/Index'); }
  onBackground(): void { probe.stop(); }
  onDestroy(): void { probe.stop(); }
}
