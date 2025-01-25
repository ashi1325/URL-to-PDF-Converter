document.addEventListener('DOMContentLoaded', () => {
  const convertButton = document.getElementById('convert');
  const statusElement = document.getElementById('status');

  convertButton.addEventListener('click', async () => {
    try {
      statusElement.textContent = 'Fetching webpage content...';

      const activeTab = await getActiveTab();
      if (!activeTab || !activeTab.url.startsWith('http')) {
        throw new Error('Cannot access non-HTTP(S) pages or restricted URLs.');
      }

      const pageContent = await capturePageContent(activeTab.id);
      if (!pageContent || !pageContent.html) {
        throw new Error('Failed to capture page content.');
      }

      await loadRequiredLibraries();

      statusElement.textContent = 'Rendering webpage as PDF...';

      const pdf = await generatePDF(pageContent.html, activeTab.url);

      const filename = prompt('Enter PDF filename:', 'webpage.pdf') || 'webpage.pdf';
      pdf.save(filename);

      statusElement.textContent = 'PDF generated successfully!';
    } catch (error) {
      console.error('Error generating PDF:', error);
      statusElement.textContent = `Error: ${error.message}`;
    }
  });
});

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}
function splitContentToPages(container, pageHeight) {
  const chunks = [];
  let currentChunk = document.createElement('div');
  let currentHeight = 0;

  Array.from(container.children).forEach((child) => {
    const childHeight = child.offsetHeight;
    if (currentHeight + childHeight > pageHeight) {
      chunks.push(currentChunk);
      currentChunk = document.createElement('div');
      currentHeight = 0;
    }
    currentChunk.appendChild(child.cloneNode(true));
    currentHeight += childHeight;
  });

  if (currentChunk.childElementCount > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}


async function capturePageContent(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        func: () => {
          return new Promise(async (resolve) => {
            const scrollAndLoad = async () => {
              const scrollStep = 500;
              const delay = 500;

              const maxScroll = async (direction, length) => {
                let lastPos = -1;
                while (lastPos !== window[direction]) {
                  lastPos = window[direction];
                  window.scrollBy(length, length);
                  await new Promise((r) => setTimeout(r, delay));
                }
              };

              await maxScroll('scrollY', scrollStep);
              await maxScroll('scrollX', scrollStep);
              window.scrollTo(0, 0);
            };

            const processDynamicContent = () => {
              document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
                img.loading = 'eager';
                if (img.dataset.src) img.src = img.dataset.src;
              });

              document.querySelectorAll('canvas').forEach((canvas) => {
                const img = new Image();
                img.src = canvas.toDataURL();
                img.style.width = canvas.style.width;
                img.style.height = canvas.style.height;
                canvas.replaceWith(img);
              });
            };

            try {
              await scrollAndLoad();
              processDynamicContent();

              await new Promise((r) => setTimeout(r, 2000));
              resolve({ html: document.documentElement.outerHTML });
            } catch (error) {
              resolve({ html: null, error: error.message });
            }
          });
        },
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (results && results[0] && results[0].result) {
          resolve(results[0].result);
        } else {
          reject(new Error('Failed to capture page content.'));
        }
      }
    );
  });
}

async function loadRequiredLibraries() {
  await loadScript('html2canvas.min.js');
  await loadScript('jspdf.umd.min.js');
}

async function loadScript(fileName) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(fileName);
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${fileName}`));
    document.body.appendChild(script);
  });
}

async function generatePDF(htmlContent, baseUrl) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `
    position: absolute;
    top: -9999px;
    width: 1024px;
    height: auto;
    border: none;
  `;
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
  iframeDoc.open();
  iframeDoc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <base href="${baseUrl}">
        <style>
          body { margin: 0; }
          img { max-width: 100%; height: auto; }
        </style>
      </head>
      <body>${htmlContent}</body>
    </html>
  `);
  iframeDoc.close();

  await new Promise((resolve) => {
    const checkReadyState = () => {
      if (iframeDoc.readyState === 'complete') {
        setTimeout(resolve, 3000);
      } else {
        setTimeout(checkReadyState, 100);
      }
    };
    checkReadyState();
  });

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = pdf.internal.pageSize.getHeight();

  const canvas = await html2canvas(iframeDoc.body, {
    useCORS: true,
    allowTaint: true,
    scale: 2,
    logging: false,
    windowWidth: 1024,
    windowHeight: iframeDoc.documentElement.scrollHeight,
    onclone: (clonedDoc) => {
      clonedDoc.querySelectorAll('img').forEach((img) => {
        if (img.dataset.src) {
          img.src = img.dataset.src;
        }
        img.loading = 'eager';
      });
    },
  });

  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  const imgWidth = pdfWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = 0;
  let pageCount = 0;

  while (heightLeft > 0) {
    if (pageCount > 0) {
      pdf.addPage();
    }
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, '', 'FAST');
    heightLeft -= pdfHeight;
    position -= pdfHeight;
    pageCount++;
  }

  document.body.removeChild(iframe);
  return pdf;
} 