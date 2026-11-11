import { display } from '@kit.ArkUI';
import * as probe from 'libcaptureprobe.so';

@Entry
@Component
struct Index {
  @State status: string = '未开始';
  @State frames: number = 0;
  @State fps: number = 0;
  @State tick: number = 0;
  private pollId: number = -1;
  private stopId: number = -1;
  private animationId: number = -1;

  private stop(): boolean {
    if (this.pollId !== -1) clearInterval(this.pollId);
    if (this.stopId !== -1) clearTimeout(this.stopId);
    if (this.animationId !== -1) clearInterval(this.animationId);
    this.pollId = -1;
    this.stopId = -1;
    this.animationId = -1;
    const result = probe.stop();
    const stats = probe.stats();
    if (stats.active !== 0) {
      this.status = `释放失败 ${stats.releaseError}，请点击停止重试`;
      return false;
    }
    this.status = result === 0 ? '已停止' : `已释放，停止返回 ${result}`;
    return true;
  }

  private start(): void {
    if (this.pollId !== -1) {
      if (probe.stats().active !== 0) return;
      this.stop();
    }
    const previous = probe.stats();
    if (previous.active !== 0) {
      this.status = `存在未释放的采集对象（${previous.releaseError}），请点击停止重试`;
      return;
    }
    try {
      const screen = display.getDefaultDisplaySync();
      const width = Math.max(2, Math.floor(screen.width * 0.4 / 2) * 2);
      const height = Math.max(2, Math.floor(screen.height * 0.4 / 2) * 2);
      const result = probe.start(width, height);
      if (result !== 0) {
        const failed = probe.stats();
        this.status = failed.active !== 0 ?
          `启动或释放失败 ${result}，请点击停止重试` : `启动失败 ${result}`;
        return;
      }
      this.frames = 0;
      this.fps = 0;
      this.status = '等待系统授权';
      this.animationId = setInterval(() => { this.tick += 1; }, 33);
      this.pollId = setInterval(() => {
        const stats = probe.stats();
        this.frames = stats.frames;
        if (stats.active === 0 || stats.error !== 0 ||
          stats.state === 1 || stats.state === 2 || stats.state === 3 || stats.state === 4 || stats.state === 10) {
          if (!this.stop()) return;
          this.status = stats.error !== 0 ? `采集错误 ${stats.error}` : `采集已结束（系统状态 ${stats.state}）`;
          return;
        }
        this.fps = stats.elapsedMs > 0 ? Math.round((stats.frames - 1) * 10000 / stats.elapsedMs) / 10 : 0;
        this.status = stats.error !== 0 ? `采集错误 ${stats.error}` : `系统状态 ${stats.state}`;
      }, 500);
      this.stopId = setTimeout(() => this.stop(), 20000);
    } catch {
      if (this.stop()) this.status = '无法启动采集';
    }
  }

  onPageShow(): void {
    const stats = probe.stats();
    if (stats.active !== 0 && stats.releaseError !== 0) {
      this.status = `后台释放失败 ${stats.releaseError}，请点击停止重试`;
    } else if (this.pollId !== -1 && stats.active === 0) {
      this.stop();
    }
  }

  onPageHide(): void { this.stop(); }

  aboutToDisappear(): void { this.stop(); }

  build() {
    Column({ space: 18 }) {
      Text('连续采集能力测试').fontSize(24).fontWeight(FontWeight.Bold)
      Text('仅统计视频帧，不保存或传输画面；前台运行约 20 秒后自动停止。')
      Text(`状态：${this.status}`)
      Text(`视频帧：${this.frames}；平均帧率：${this.fps}`)
      Text(`画面变化：${this.tick}`).fontColor(this.tick % 2 === 0 ? Color.Blue : Color.Green)
      Row({ space: 12 }) {
        Button('开始测试').onClick(() => this.start())
        Button('停止').onClick(() => this.stop())
      }
    }.width('100%').height('100%').justifyContent(FlexAlign.Center).padding(24)
  }
}
