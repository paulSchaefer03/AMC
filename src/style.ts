
export function initStyle(){
    window.addEventListener("resize", () => {
        const videoContainer = document.querySelector(".video-container") as HTMLDivElement;
        if (videoContainer) {
          const aspectRatio = 16 / 9;
          const width = Math.min(window.innerWidth * 0.9, 800);
          videoContainer.style.width = `${width}px`;
          videoContainer.style.height = `${width / aspectRatio}px`;
        }
    });
}
