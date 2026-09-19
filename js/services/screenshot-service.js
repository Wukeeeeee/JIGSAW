/* ============================================================
   JIGSAW — ScreenshotService
   屏幕截图服务：调用浏览器 / 桌面 API 进行屏幕或窗口截图，
   导出 PNG 图片并支持上传至后端或转换为 Data URL。
   ============================================================ */
(function () {
  const ScreenshotService = {
    /**
     * 捕获屏幕或指定窗口单帧截图
     * @returns {Promise<{dataUrl: string, blob: Blob, filename: string}|null>}
     */
    async captureScreen() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error("当前浏览器环境不支持屏幕截图 API");
      }

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: "always" },
          audio: false
        });
      } catch (err) {
        if (err.name === "NotAllowedError" || err.name === "AbortError") {
          // 用户取消了屏幕选择弹窗
          return null;
        }
        throw new Error("获取屏幕画面失败: " + err.message);
      }

      try {
        const video = document.createElement("video");
        video.srcObject = stream;
        video.autoplay = true;
        video.muted = true;

        await new Promise((resolve, reject) => {
          video.onloadedmetadata = () => {
            video.play().then(resolve).catch(reject);
          };
          setTimeout(() => reject(new Error("视频画面加载超时")), 5000);
        });

        // 稍微等待 100ms 确保画面帧完全渲染
        await new Promise(r => setTimeout(r, 100));

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // 停止视频采集轨道
        stream.getTracks().forEach(track => track.stop());

        const dataUrl = canvas.toDataURL("image/png");

        const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
        const filename = "screenshot_" + Date.now() + ".png";

        return { dataUrl, blob, filename };
      } catch (err) {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }
        throw err;
      }
    },

    /**
     * 如果后端在运行，可将图片上传到后端生成的静态图片目录
     */
    async uploadScreenshot(blob, filename) {
      if (!JIGSAW.Http || !JIGSAW.Http.isRemote()) {
        return null;
      }
      try {
        const formData = new FormData();
        formData.append("file", blob, filename || ("screenshot_" + Date.now() + ".png"));
        const res = await JIGSAW.Http.request("/api/files/upload_image", {
          method: "POST",
          body: formData,
          isFormData: true
        });
        return res && res.url ? res.url : null;
      } catch (e) {
        console.warn("截图上传后端失败，降级使用本地 Data URL", e);
        return null;
      }
    }
  };

  JIGSAW.ScreenshotService = ScreenshotService;
})();
