// Validasi sebelum halaman ditutup atau di-refresh
window.addEventListener('beforeunload', function (e) {
    // Cek apakah ada draft yang belum dikirim
    if (Object.keys(noteDrafts).length > 0) {
        // Pesan kustom (meskipun browser mungkin mengabaikan pesan ini dan menampilkan default)
        const confirmationMessage = 'Anda memiliki draft yang belum dikirim. Jika Anda meninggalkan halaman ini, semua draft akan hilang. Apakah Anda yakin ingin melanjutkan?';
        
        // Set pesan ke event (diperlukan untuk beberapa browser)
        e.returnValue = confirmationMessage;
        return confirmationMessage;
    }
    // Jika tidak ada draft, biarkan halaman ditutup tanpa peringatan
});

// Variabel global untuk draft dan drag state
let noteDrafts = {};
let selectedWebhooks = new Set();
let draggedItem = null;
let dragStartIndex = null;
let dragWebhookUrl = null;
let holdTimeout = null;
let isDragging = false;
let editingWebhookUrl = null;
let editingIndex = null;
let sortDirection = 'asc'; // Default: ascending
let fileQueue = [];
let isSending = false;

// Tambahkan mutex untuk drag & drop
let dragMutex = false;

// Tambahkan konstanta untuk konfigurasi
const CONFIG = {
    WEBHOOK_TIMEOUT: 10000, // 10 detik timeout untuk setiap request
    MAX_RETRIES: 3, // Maksimal retry jika gagal
    RATE_LIMIT_DELAY: 2000, // Delay tambahan jika terkena rate limit
};

// Tambahkan konstanta untuk file validation
const FILE_CONFIG = {
    MAX_FILE_SIZE: 8 * 1024 * 1024, // 8MB in bytes
    ALLOWED_IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/gif'],
    ALLOWED_AUDIO_TYPES: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/m4a'],
    MAX_FILES_PER_UPLOAD: 10
};

// Fungsi helper untuk timeout promise
function timeoutPromise(promise, timeout) {
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), timeout)
        )
    ]);
}

// Fungsi untuk mengirim single request dengan retry
async function sendWithRetry(url, options, retryCount = 0) {
    try {
        const response = await timeoutPromise(
            fetch(url, options),
            CONFIG.WEBHOOK_TIMEOUT
        );

        // Handle rate limiting
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || 5;
            await delay(retryAfter * 1000 + CONFIG.RATE_LIMIT_DELAY);
            return sendWithRetry(url, options, retryCount);
        }

        // Handle other error status
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response;
    } catch (error) {
        if (retryCount < CONFIG.MAX_RETRIES) {
            await delay(Math.pow(2, retryCount) * 1000); // Exponential backoff
            return sendWithRetry(url, options, retryCount + 1);
        }
        throw error;
    }
}

// Tambahkan fungsi untuk membersihkan event listeners
function cleanupEventListeners() {
    const selector = document.querySelector('.webhook-selector');
    if (!selector) return;
    
    const selectedDiv = selector.querySelector('.selected');
    const dropdown = selector.querySelector('.dropdown');
    const options = dropdown.querySelectorAll('.option');
    
    // Bersihkan event listeners
    selectedDiv.removeEventListener('click', handleSelectedDivClick);
    selectedDiv.removeEventListener('keypress', handleSelectedDivKeypress);
    options.forEach(option => option.removeEventListener('click', handleOptionClick));
    document.removeEventListener('click', handleDocumentClick);
}

// Pisahkan handler functions agar bisa di-remove
function handleSelectedDivClick(e) {
    e.stopPropagation();
    const dropdown = document.querySelector('.webhook-selector .dropdown');
    dropdown.classList.toggle('show');
}

function handleSelectedDivKeypress(e) {
    const letter = e.key.toUpperCase();
    if (letter.length === 1 && letter.match(/[A-Z]/)) {
        const dropdown = document.querySelector('.webhook-selector .dropdown');
        const options = dropdown.querySelectorAll('.option');
        options.forEach(option => {
            const optionText = option.textContent.trim().toUpperCase();
            if (optionText.startsWith(letter)) {
                option.classList.remove('hidden');
            } else {
                option.classList.add('hidden');
            }
        });
        dropdown.classList.add('show');
    }
}

function handleOptionClick(e) {
    e.stopPropagation();
    const value = this.getAttribute('data-value');
    const selector = document.querySelector('.webhook-selector');
    const selectedDiv = selector.querySelector('.selected');
    const options = selector.querySelectorAll('.option');
    
    options.forEach(opt => opt.classList.remove('selected'));
    this.classList.add('selected');
    selectedDiv.textContent = this.textContent;
    selectedWebhooks.clear();
    selectedWebhooks.add(value);
}

function handleDocumentClick(e) {
    const selector = document.querySelector('.webhook-selector');
    const dropdown = selector.querySelector('.dropdown');
    if (!selector.contains(e.target)) {
        dropdown.classList.remove('show');
    }
}

// Modifikasi fungsi initializeWebhookSelector
function initializeWebhookSelector() {
    // Bersihkan event listeners yang ada
    cleanupEventListeners();
    
    const selector = document.querySelector('.webhook-selector');
    if (!selector) {
        console.error('Webhook selector not found');
        return;
    }

    const selectedDiv = selector.querySelector('.selected');
    const dropdown = selector.querySelector('.dropdown');
    const options = dropdown.querySelectorAll('.option');

    // Tambahkan event listeners baru
    selectedDiv.addEventListener('click', handleSelectedDivClick);
    selectedDiv.addEventListener('keypress', handleSelectedDivKeypress);
    options.forEach(option => option.addEventListener('click', handleOptionClick));
    document.addEventListener('click', handleDocumentClick);
}

// Fungsi untuk mendapatkan webhook yang dipilih (tidak berubah)
function getSelectedWebhooks() {
    const options = Array.from(document.querySelectorAll('.webhook-selector .option'));
    return Array.from(selectedWebhooks).map(value => {
        const option = options.find(opt => opt.getAttribute('data-value') === value);
        return {
            url: value,
            name: option.textContent.trim()
        };
    });
}

// Fungsi untuk memperbarui draft sections
function updateDraftSections() {
    const draftSections = document.getElementById('draft-sections');
    if (!draftSections) return;

    // Store the state of existing sections before clearing
    const existingState = Array.from(draftSections.children).map(section => {
        const container = section.querySelector('.grid');
        return container ? container.style.display === 'none' : false;
    });

    // If there are existing sections, use their state for new sections
    const shouldCollapse = existingState.length > 0 ? existingState[0] : false;

    draftSections.innerHTML = '';

    Object.entries(noteDrafts).forEach(([webhookUrl, data], sectionIndex) => {
        const section = document.createElement('div');
        section.classList.add('bg-gray-50', 'mb-6', 'rounded-xl', 'p-6', 'border', 'border-gray-200', 'shadow-sm');

        const headerContainer = document.createElement('div');
        headerContainer.classList.add('flex', 'justify-between', 'items-center', 'mb-4', 'pb-2', 'border-b', 'border-gray-200');

        const header = document.createElement('h3');
        header.textContent = `${data.name} Drafts`;
        header.classList.add('text-lg', 'font-semibold', 'text-gray-800');

        const toggleButton = document.createElement('button');
        toggleButton.textContent = shouldCollapse ? 'Expand' : 'Collapse';
        toggleButton.classList.add('px-3', 'py-1.5', 'text-xs', 'font-medium', 'rounded-lg', 'bg-gray-100', 'text-gray-700', 'hover:bg-gray-200', 'transition-colors', 'duration-200');
        toggleButton.onclick = () => toggleSection(toggleButton);

        headerContainer.appendChild(header);
        headerContainer.appendChild(toggleButton);
        section.appendChild(headerContainer);

        const container = document.createElement('div');
        container.classList.add('grid', 'gap-4', 'grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3');
        container.dataset.webhookUrl = webhookUrl;
        
        // Apply the collapse state
        if (shouldCollapse) {
            container.style.display = 'none';
        }

        data.items.forEach((item, index) => {
            const draftElement = document.createElement('div');
            draftElement.classList.add('draft-item', 'bg-white', 'rounded-lg', 'p-4', 'border', 'border-gray-200', 'shadow-sm', 'hover:shadow-md', 'transition-all', 'duration-200');
            draftElement.dataset.index = index;
            draftElement.setAttribute('draggable', 'true');

            const title = document.createElement('h4');
            title.textContent = `Draft ${index + 1}`;
            title.classList.add('text-sm', 'font-medium', 'text-gray-700', 'mb-3', 'pb-2', 'border-b', 'border-gray-100');

            const contentContainer = document.createElement('div');
            contentContainer.classList.add('space-y-3');
            
            if (item.isImage) {
                const imgContainer = document.createElement('div');
                imgContainer.classList.add('relative', 'group');
                
                const imgPreview = document.createElement('img');
                imgPreview.src = item.content;
                imgPreview.loading = "lazy";
                imgPreview.classList.add('w-full', 'h-48', 'object-cover', 'rounded-lg', 'shadow-sm', 'cursor-pointer', 'transition-transform', 'duration-200', 'group-hover:brightness-75');
                imgPreview.onclick = () => openImagePreviewModal(item.content);
                
                const zoomIcon = document.createElement('div');
                zoomIcon.innerHTML = '<i data-lucide="zoom-in" class="w-6 h-6"></i>';
                zoomIcon.classList.add('absolute', 'top-1/2', 'left-1/2', 'transform', '-translate-x-1/2', '-translate-y-1/2', 'text-white', 'opacity-0', 'group-hover:opacity-100', 'transition-opacity', 'duration-200', 'pointer-events-none');
                
                imgContainer.appendChild(imgPreview);
                imgContainer.appendChild(zoomIcon);
                contentContainer.appendChild(imgContainer);
                title.innerHTML = `<i data-lucide="image" class="w-4 h-4 inline mr-2"></i> Draft ${index + 1}`;
                lucide.createIcons();
            } else if (item.isAudio) {
                const audioPreview = document.createElement('audio');
                audioPreview.controls = true;
                audioPreview.src = item.content;
                audioPreview.classList.add('w-full', 'rounded-lg');
                contentContainer.appendChild(audioPreview);
                title.innerHTML = `<i data-lucide="mic" class="w-4 h-4 inline mr-2"></i> Draft ${index + 1}`;
            } else {
                const preview = document.createElement('p');
                preview.textContent = item.content.substring(0, 100) + (item.content.length > 100 ? '...' : '');
                preview.classList.add('text-sm', 'text-gray-600', 'line-clamp-3');
                contentContainer.appendChild(preview);
                title.innerHTML = `<i data-lucide="file-text" class="w-4 h-4 inline mr-2"></i> Draft ${index + 1}`;
            }

            const actions = document.createElement('div');
            actions.classList.add('actions', 'flex', 'justify-end', 'gap-2', 'mt-4', 'pt-3', 'border-t', 'border-gray-100');

            const editButton = document.createElement('button');
            editButton.classList.add('edit', 'px-3', 'py-1.5', 'text-xs', 'font-medium', 'rounded-lg', 'bg-blue-50', 'text-blue-700', 'hover:bg-blue-100', 'transition-colors', 'duration-200');
            editButton.textContent = 'Edit';
            editButton.onclick = () => openEditModal(webhookUrl, index);
            actions.appendChild(editButton);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Delete';
            deleteButton.classList.add('px-3', 'py-1.5', 'text-xs', 'font-medium', 'rounded-lg', 'bg-red-50', 'text-red-700', 'hover:bg-red-100', 'transition-colors', 'duration-200');
            deleteButton.onclick = () => deleteDraft(webhookUrl, index);
            actions.appendChild(deleteButton);

            draftElement.appendChild(title);
            draftElement.appendChild(contentContainer);
            draftElement.appendChild(actions);
            container.appendChild(draftElement);

            // Add both touch and drag event listeners
            draftElement.addEventListener('touchstart', handleTouchStart, { passive: false });
            draftElement.addEventListener('dragstart', handleDragStart);
            draftElement.addEventListener('dragover', handleDragOver);
            draftElement.addEventListener('drop', handleDrop);
            draftElement.addEventListener('dragend', handleDragEnd);
        });

        section.appendChild(container);
        draftSections.appendChild(section);
    });
}

// Handle touch start untuk hold to drag
function handleTouchStart(event) {
    event.preventDefault();
    const draftItem = event.target.closest('.draft-item');
    if (!draftItem) return;

    if (event.target.tagName === 'BUTTON') return;
    if (dragMutex) return;

    holdTimeout = setTimeout(() => {
        dragMutex = true;
        isDragging = true;
        document.body.classList.add('dragging-active');
        draggedItem = draftItem;
        dragStartIndex = parseInt(draftItem.dataset.index);
        dragWebhookUrl = draftItem.parentElement.dataset.webhookUrl;
        draftItem.classList.add('dragging');
        if (window.navigator.vibrate) {
            window.navigator.vibrate(50);
        }
        startDragging(event);
    }, 500);

    function cancelHold() {
        if (holdTimeout) {
            clearTimeout(holdTimeout);
            holdTimeout = null;
        }
        document.removeEventListener('touchend', cancelHold);
        document.removeEventListener('touchmove', cancelHold);
    }

    document.addEventListener('touchend', cancelHold, { once: true });
    document.addEventListener('touchmove', cancelHold, { once: true });
}

// Fungsi untuk memulai drag pada perangkat sentuh
function startDragging(event) {
    if (!draggedItem || !isDragging) return;

    const touch = event.touches[0];
    let lastTouchY = touch.clientY;
    let scrolling = false;

    function onTouchMove(event) {
        event.preventDefault();
        const touch = event.touches[0];
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetItem = target?.closest('.draft-item');

        // Deteksi scroll vs drag
        const touchDeltaY = touch.clientY - lastTouchY;
        if (Math.abs(touchDeltaY) > 5) {
            scrolling = true;
        }
        lastTouchY = touch.clientY;

        if (targetItem && targetItem !== draggedItem && !scrolling) {
            const container = draggedItem.parentElement;
            const items = Array.from(container.children);
            const targetIndex = parseInt(targetItem.dataset.index);
            const currentIndex = parseInt(draggedItem.dataset.index);

            if (targetIndex !== currentIndex) {
                // Use requestAnimationFrame untuk smooth reordering
                requestAnimationFrame(() => {
                    const moveAfter = touch.clientY > targetItem.getBoundingClientRect().top + (targetItem.offsetHeight / 2);
                    if (moveAfter && targetIndex > currentIndex) {
                        container.insertBefore(draggedItem, targetItem.nextSibling);
                    } else if (!moveAfter && targetIndex < currentIndex) {
                        container.insertBefore(draggedItem, targetItem);
                    }

                    // Update indices
                    items.forEach((item, idx) => {
                        item.dataset.index = idx;
                    });

                    // Update data model
                    const itemsArray = noteDrafts[dragWebhookUrl].items;
                    const [movedItem] = itemsArray.splice(dragStartIndex, 1);
                    const newIndex = Array.from(container.children).indexOf(draggedItem);
                    itemsArray.splice(newIndex, 0, movedItem);
                    dragStartIndex = newIndex;
                });
            }
        }
    }

    function onTouchEnd() {
        resetDragState();
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    }

    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { once: true });
}

// Fungsi untuk membuka modal edit
function openEditModal(webhookUrl, index) {
    const modal = document.getElementById('edit-modal');
    const textarea = document.getElementById('edit-textarea');
    const imageInput = document.getElementById('edit-image-input');
    const imagePreview = document.getElementById('edit-image-preview');
    const item = noteDrafts[webhookUrl].items[index];

    editingWebhookUrl = webhookUrl;
    editingIndex = index;

    if (item.isImage) {
        textarea.style.display = 'none';
        imageInput.style.display = 'block';
        imagePreview.style.display = 'block';
        imagePreview.src = item.content;
    } else if (item.isAudio) {
        textarea.style.display = 'none';
        imageInput.style.display = 'block';
        imageInput.accept = 'audio/*'; // Ubah accept untuk audio
        imagePreview.style.display = 'none'; // Audio tidak perlu preview gambar
        // Tambahkan elemen audio sementara untuk preview (opsional)
        const audioPreview = document.createElement('audio');
        audioPreview.controls = true;
        audioPreview.src = item.content;
        audioPreview.style.width = '100%';
        modal.querySelector('.bg-white').insertBefore(audioPreview, modal.querySelector('.flex'));
    } else {
        textarea.style.display = 'block';
        imageInput.style.display = 'none';
        imagePreview.style.display = 'none';
        textarea.value = item.content;
    }

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        const modalContent = modal.children[0];
        modalContent.classList.add('scale-100', 'opacity-100');
        modalContent.classList.remove('scale-95', 'opacity-0');
    }, 10);
}

// Fungsi untuk preview gambar saat mengedit
function previewEditImage(input) {
    const file = input.files[0];
    const imagePreview = document.getElementById('edit-image-preview');
    if (file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            imagePreview.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

// Fungsi untuk menyimpan perubahan draft
function saveEditDraft() {
    const textarea = document.getElementById('edit-textarea');
    const imageInput = document.getElementById('edit-image-input');
    const status = document.getElementById("status");
    const item = noteDrafts[editingWebhookUrl].items[editingIndex];

    if (item.isImage || item.isAudio) {
        if (imageInput.files.length > 0) {
            const file = imageInput.files[0];
            const reader = new FileReader();
            reader.onload = function (e) {
                const blob = dataURLtoBlob(e.target.result);

                if (blob.size > 8 * 1024 * 1024) {
                    status.textContent = `${item.isImage ? 'Gambar' : 'Audio'} terlalu besar (${(blob.size / (1024 * 1024)).toFixed(2)}MB). Maksimal 8MB!`;
                    status.classList.remove("text-green-500");
                    status.classList.add("text-red-500");
                    return;
                }
                const fileType = file.name.split(".").pop().toLowerCase();
                noteDrafts[editingWebhookUrl].items[editingIndex].content = e.target.result;
                if (item.isAudio) {
                    noteDrafts[editingWebhookUrl].items[editingIndex].isImage = false;
                    noteDrafts[editingWebhookUrl].items[editingIndex].isAudio = true;
                    noteDrafts[editingWebhookUrl].items[editingIndex].fileName = `${generateMD5Hash()}.${fileType}`;
                } else if (item.isImage) {
                    noteDrafts[editingWebhookUrl].items[editingIndex].isImage = true;
                    noteDrafts[editingWebhookUrl].items[editingIndex].isAudio = false;
                    noteDrafts[editingWebhookUrl].items[editingIndex].fileName = `${generateMD5Hash()}.${fileType}`;
                }
                updateDraftSections();
                closeEditModal();
                status.textContent = "Draft berhasil diperbarui!";
                status.classList.remove("text-red-500");
                status.classList.add("text-green-500");
            };
            reader.readAsDataURL(file);
        } else {
            closeEditModal();
        }
    } else {
        const newText = textarea.value.trim();
        if (newText === '') {
            status.textContent = "Pesan tidak boleh kosong!";
            status.classList.remove("text-green-500");
            status.classList.add("text-red-500");
            return;
        }
        if (newText.length > 2000) {
            status.textContent = `Pesan terlalu panjang (${newText.length} karakter). Maksimal 2000 karakter!`;
            status.classList.remove("text-green-500");
            status.classList.add("text-red-500");
            return;
        }
        noteDrafts[editingWebhookUrl].items[editingIndex].content = newText;
        updateDraftSections();
        closeEditModal();
        status.textContent = "Draft berhasil diperbarui!";
        status.classList.remove("text-red-500");
        status.classList.add("text-green-500");
    }
}

// Fungsi untuk menutup modal edit
function closeEditModal() {
    const modal = document.getElementById('edit-modal');
    const modalContent = modal.children[0];
    modal.classList.remove('opacity-100');
    modalContent.classList.remove('scale-100', 'opacity-100');
    modalContent.classList.add('scale-95', 'opacity-0');
    
    // Bersihkan audio preview jika ada
    const audioPreview = modal.querySelector('audio');
    if (audioPreview) {
        audioPreview.pause();
        audioPreview.remove();
    }
    
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
    
    // Reset input
    document.getElementById('edit-textarea').value = '';
    document.getElementById('edit-image-input').value = '';
    document.getElementById('edit-image-preview').style.display = 'none';
    editingWebhookUrl = null;
    editingIndex = null;
}

// Modifikasi fungsi handleDragStart
function handleDragStart(event) {
    if (dragMutex) return;
    dragMutex = true;
    
    draggedItem = event.target.closest('.draft-item');
    if (!draggedItem) {
        dragMutex = false;
        return;
    }
    
    draggedItem.classList.add('dragging');
    dragStartIndex = parseInt(draggedItem.dataset.index);
    dragWebhookUrl = draggedItem.parentElement.dataset.webhookUrl;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "dragging");
}

// Modifikasi fungsi handleDragOver
function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const target = event.target.closest('.draft-item');
    if (!draggedItem || !target || draggedItem === target) return;

    const container = draggedItem.parentElement;
    const items = Array.from(container.children);
    const draggedIndex = parseInt(draggedItem.dataset.index);
    const targetIndex = parseInt(target.dataset.index);

    // Prevent unnecessary DOM updates
    if (draggedIndex === targetIndex) return;

    // Use requestAnimationFrame untuk smooth reordering
    requestAnimationFrame(() => {
        if (draggedIndex < targetIndex) {
            container.insertBefore(draggedItem, target.nextSibling);
        } else {
            container.insertBefore(draggedItem, target);
        }

        // Update indices
        items.forEach((item, idx) => {
            item.dataset.index = idx;
        });
    });
}

// Modifikasi fungsi handleDrop
function handleDrop(event) {
    event.preventDefault();
    if (!draggedItem) return;

    try {
        const container = draggedItem.parentElement;
        const items = Array.from(container.children);
        const newIndex = items.indexOf(draggedItem);
        
        if (newIndex === -1 || !dragWebhookUrl || !noteDrafts[dragWebhookUrl]) {
            throw new Error('Invalid drag & drop state');
        }

        const itemsArray = noteDrafts[dragWebhookUrl].items;
        const [movedItem] = itemsArray.splice(dragStartIndex, 1);
        itemsArray.splice(newIndex, 0, movedItem);

        // Update UI to reflect the new order
        updateDraftSections();
    } catch (error) {
        console.error('Error during drag & drop:', error);
        // Revert to original state if error occurs
        updateDraftSections();
    } finally {
        resetDragState();
    }
}

// Modifikasi fungsi handleDragEnd
function handleDragEnd(event) {
    resetDragState();
}

// Modifikasi fungsi resetDragState
function resetDragState() {
    isDragging = false;
    dragMutex = false;
    document.body.classList.remove('dragging-active');
    if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem = null;
    }
    dragStartIndex = null;
    dragWebhookUrl = null;
    if (holdTimeout) {
        clearTimeout(holdTimeout);
        holdTimeout = null;
    }
}

// Fungsi untuk toggle expand/collapse section
function toggleSection(button) {
    const section = button.closest('div').parentElement;
    const container = section.querySelector('.grid');
    
    if (container.style.display === 'none') {
        container.style.display = 'grid';
        button.textContent = 'Collapse';
    } else {
        container.style.display = 'none';
        button.textContent = 'Expand';
    }
}

// Fungsi untuk validasi data sebelum pengiriman
function validateData() {
    const status = document.getElementById("status");
    let isValid = true;
    let errorMessage = '';

    // Periksa jumlah item per webhook
    Object.entries(noteDrafts).forEach(([webhookUrl, data]) => {
        const itemCount = data.items.length;
        if (itemCount === 0) {
            isValid = false;
            errorMessage = `Webhook "${data.name}" tidak memiliki pesan, gambar, atau audio untuk dikirim!`;
            return;
        }
        if (itemCount > 100) {
            isValid = false;
            errorMessage = `Webhook "${data.name}" memiliki terlalu banyak item (${itemCount}). Maksimal 100 item per webhook!`;
            return;
        }
    });

    if (!isValid) return { isValid, errorMessage };

    // Validasi setiap item di setiap webhook
    for (const [webhookUrl, data] of Object.entries(noteDrafts)) {
        for (let i = 0; i < data.items.length; i++) {
            const item = data.items[i];
            if (!item.isImage && !item.isAudio) { // Hanya untuk teks
                const text = item.content.trim();
                if (text === '') {
                    isValid = false;
                    errorMessage = `Pesan ke-${i + 1} di webhook "${data.name}" kosong!`;
                    return { isValid, errorMessage };
                }
                if (text.length > 2000) {
                    isValid = false;
                    errorMessage = `Pesan ke-${i + 1} di webhook "${data.name}" terlalu panjang (${text.length} karakter). Maksimal 2000 karakter!`;
                    return { isValid, errorMessage };
                }
            } else { // Untuk gambar atau audio
                const blob = dataURLtoBlob(item.content);
                if (blob.size > 8 * 1024 * 1024) {
                    isValid = false;
                    errorMessage = `${item.isImage ? 'Gambar' : 'Audio'} ke-${i + 1} di webhook "${data.name}" terlalu besar (${(blob.size / (1024 * 1024)).toFixed(2)}MB). Maksimal 8MB!`;
                    return { isValid, errorMessage };
                }
            }
        }
    }

    return { isValid, errorMessage };
}

// Modifikasi sendData untuk menambahkan validasi (tidak berubah)
async function sendData() {
    const status = document.getElementById("status");
    const progressContainer = document.getElementById("progress-container");
    const progressBar = document.getElementById("progress-bar");
    const loggingWebhook = "https://discord.com/api/webhooks/1347634574473040003/N3TKSwx9illFBTfRBkex9LmVhX71cc1yPnLKXg8S0GwcImRlQO9krsMfzN_4LiC-SYIc";

    if (isSending) {
        status.textContent = "Pengiriman sedang berlangsung, mohon tunggu...";
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
        return;
    }

    // Validasi dasar
    if (Object.keys(noteDrafts).length === 0) {
        status.textContent = "Tidak ada draft untuk dikirim!";
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
        return;
    }

    const { isValid, errorMessage } = validateData();
    if (!isValid) {
        status.textContent = errorMessage;
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
        return;
    }

    // Konfirmasi untuk channel ANNOUNCEMENT
    const hasAnnouncement = Object.values(noteDrafts).some(data => data.name.includes("ANNOUNCEMENT"));
    if (hasAnnouncement) {
        const confirmation = confirm("Anda akan mengirim ke channel ANNOUNCEMENT. Apakah Anda yakin?");
        if (!confirmation) return;
    }

    let sendButton;
    try {
        isSending = true;
        
        // Nonaktifkan tombol kirim
        sendButton = document.querySelector('button[onclick="sendData()"]');
        if (sendButton) {
            sendButton.disabled = true;
            sendButton.classList.add('opacity-50', 'cursor-not-allowed');
        }

        const currentDate = new Date().toLocaleString();
        const failedItems = new Map();
        const sessionHistory = {
            timestamp: currentDate,
            items: [],
            stats: {
                total: 0,
                success: 0,
                failed: 0
            }
        };

        const sendToWebhook = async (webhookUrl, data) => {
            let successCount = 0;
            const totalItems = data.items.length;
            const errors = [];

            for (let i = 0; i < data.items.length; i++) {
                const item = data.items[i];
                try {
                    await delay(1000);

                    let response;
                    if (!item.isImage && !item.isAudio) {
                        const embed = {
                            color: 0x00ff00,
                            description: item.content,
                            footer: {
                                text: `🍣 Seraya Store ・ ${currentDate}`,
                            },
                        };
                        
                        response = await sendWithRetry(webhookUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ embeds: [embed] })
                        });
                        successCount++;
                    } else {
                        const blob = dataURLtoBlob(item.content);
                        const formData = new FormData();
                        formData.append("file", blob, item.fileName || (item.isImage ? "image.png" : item.fileName));
                        
                        response = await sendWithRetry(webhookUrl, {
                            method: "POST",
                            body: formData,
                        });
                        successCount++;
                    }

                    // Tambahkan item ke history
                    sessionHistory.items.push({
                        type: item.isImage ? 'image' : item.isAudio ? 'audio' : 'text',
                        content: item.isImage || item.isAudio ? item.fileName : item.content,
                        webhook: data.name,
                        status: 'success',
                        timestamp: new Date().toLocaleString()
                    });

                    const progressPercentage = ((i + 1) / totalItems) * 100;
                    progressBar.style.width = `${progressPercentage}%`;
                } catch (error) {
                    console.error(`Error sending item ${i + 1}:`, error);
                    errors.push({ item, error: error.message });
                    failedItems.set(webhookUrl, (failedItems.get(webhookUrl) || []).concat(i));

                    // Tambahkan error ke history
                    sessionHistory.items.push({
                        type: item.isImage ? 'image' : item.isAudio ? 'audio' : 'text',
                        content: item.isImage || item.isAudio ? item.fileName : item.content,
                        webhook: data.name,
                        status: 'failed',
                        error: error.message,
                        timestamp: new Date().toLocaleString()
                    });
                }
            }

            return { successCount, errors };
        };

        // Kirim semua data dan update history
        const stats = [];
        for (const [url, data] of Object.entries(noteDrafts)) {
            const { successCount, errors } = await sendToWebhook(url, data);
            
            stats.push({
                name: data.name,
                total: data.items.length,
                success: successCount,
                text: data.items.filter(item => !item.isImage && !item.isAudio).length,
                image: data.items.filter(item => item.isImage).length,
                audio: data.items.filter(item => item.isAudio).length,
                errors: errors.length
            });

            // Update session stats
            sessionHistory.stats.total += data.items.length;
            sessionHistory.stats.success += successCount;
            sessionHistory.stats.failed += errors.length;
            
            await delay(2500);
        }

        // Simpan history session ini
        messageHistory.push(sessionHistory);
        // Batasi history ke 100 session terakhir
        if (messageHistory.length > 100) {
            messageHistory = messageHistory.slice(-100);
        }

        // Simpan history ke localStorage
        try {
            localStorage.setItem('messageHistory', JSON.stringify(messageHistory));
        } catch (e) {
            console.warn('Failed to save history to localStorage:', e);
        }

        // Kirim log ke webhook logging
        for (const stat of stats) {
            const logEmbed = {
                color: stat.errors > 0 ? 0xff0000 : 0x00ff00,
                title: "📦 Message Log Counter",
                description: `📡 **Webhook:** \`${stat.name}\`
            📤 **Terkirim:** \`${stat.success} / ${stat.total}\`
            ❌ **Gagal:** \`${stat.errors}\`
            
            📝 **Text:** \`${stat.text}\`
            🖼️ **Image:** \`${stat.image}\`
            🎵 **Audio:** \`${stat.audio}\``,
                thumbnail: {
                    url: "https://i.pinimg.com/736x/eb/4e/d8/eb4ed8604a9c37f42ad26315a3d4bbc9.jpg"
                },
                timestamp: new Date(),
                footer: {
                    text: "Seraya Store ・ Log System",
                    icon_url: "https://i.pinimg.com/736x/2a/3e/35/2a3e35bb342873ed19b5084b3db23fdc.jpg"
                }
            };
            
            try {
                await sendWithRetry(loggingWebhook, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ embeds: [logEmbed] })
                });
                await delay(1000);
            } catch (error) {
                console.error("Error sending log:", error);
            }
        }

        // Handle failed items
        if (failedItems.size > 0) {
            let failedMessage = "Beberapa item gagal terkirim:\n";
            for (const [webhook, items] of failedItems) {
                const webhookName = noteDrafts[webhook]?.name || webhook;
                failedMessage += `\n${webhookName}: Item ${items.map(i => i + 1).join(", ")}`;
            }
            status.textContent = failedMessage;
            status.classList.remove("text-green-500");
            status.classList.add("text-red-500");
        } else {
            status.textContent = "Semua data berhasil dikirim ke " + Object.keys(noteDrafts).length + " webhook!";
            status.classList.remove("text-red-500");
            status.classList.add("text-green-500");
            noteDrafts = {};
            updateDraftSections();
        }
    } catch (error) {
        console.error("Error:", error);
        status.textContent = "Terjadi kesalahan saat mengirim data: " + error.message;
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
    } finally {
        isSending = false;
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.classList.remove('opacity-50', 'cursor-not-allowed');
        }
        progressContainer.classList.add("hidden");
        progressBar.style.width = '0%';
    }

    // Setelah berhasil mengirim data dan membuat sessionHistory
    try {
        await saveHistoryToDatabase(sessionHistory);
    } catch (error) {
        console.error('Failed to save history:', error);
    }
}

// Fungsi untuk menampilkan history modal
function showHistoryModal() {
    const modal = document.getElementById('history-modal');
    const historyContent = document.getElementById('history-content');
    
    // Load history dari localStorage
    try {
        const savedHistory = localStorage.getItem('messageHistory');
        if (savedHistory) {
            messageHistory = JSON.parse(savedHistory);
        }
    } catch (e) {
        console.warn('Failed to load history from localStorage:', e);
    }

    // Generate HTML untuk history
    let historyHTML = `
        <div class="space-y-4">
            ${messageHistory.reverse().map((session, index) => `
                <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                    <div class="flex items-center justify-between mb-3">
                        <div class="flex items-center gap-2">
                            <i data-lucide="clock" class="w-5 h-5 text-gray-400"></i>
                            <span class="text-sm font-medium text-gray-600">${session.timestamp}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-sm font-medium text-gray-600">Success: ${session.stats.success}/${session.stats.total}</span>
                            ${session.stats.failed > 0 ? 
                                `<span class="text-sm font-medium text-red-600">Failed: ${session.stats.failed}</span>` : 
                                ''
                            }
                        </div>
                    </div>
                    <div class="space-y-2">
                        ${session.items.map(item => `
                            <div class="flex items-center justify-between py-2 border-t border-gray-100">
                                <div class="flex items-center gap-2">
                                    <i data-lucide="${item.type === 'image' ? 'image' : item.type === 'audio' ? 'mic' : 'file-text'}" 
                                       class="w-4 h-4 ${item.status === 'success' ? 'text-green-500' : 'text-red-500'}"></i>
                                    <span class="text-sm text-gray-600">${
                                        item.type === 'text' ? 
                                        (item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content) : 
                                        item.content
                                    }</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-xs text-gray-500">${item.webhook}</span>
                                    <span class="px-2 py-1 text-xs rounded-full ${
                                        item.status === 'success' ? 
                                        'bg-green-50 text-green-600' : 
                                        'bg-red-50 text-red-600'
                                    }">${item.status}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    historyContent.innerHTML = historyHTML;

    // Tampilkan modal
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        const modalContent = modal.children[0];
        modalContent.classList.add('scale-100', 'opacity-100');
        modalContent.classList.remove('scale-95', 'opacity-0');
        // Reinisialisasi ikon Lucide
        lucide.createIcons();
    }, 10);
}

// Fungsi untuk menutup history modal
function closeHistoryModal() {
    const modal = document.getElementById('history-modal');
    const modalContent = modal.children[0];
    modal.classList.remove('opacity-100');
    modalContent.classList.remove('scale-100', 'opacity-100');
    modalContent.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Fungsi untuk membersihkan history
function clearHistory() {
    if (confirm('Apakah Anda yakin ingin menghapus semua riwayat pengiriman?')) {
        messageHistory = [];
        localStorage.removeItem('messageHistory');
        closeHistoryModal();
    }
}

// Fungsi untuk memeriksa konten duplikat
function checkDuplicateContent(webhookUrl, content, isImage = false, isAudio = false) {
    if (!noteDrafts[webhookUrl]) return false;
    
    return noteDrafts[webhookUrl].items.some(item => {
        // Jika tipe konten berbeda, bukan duplikat
        if (item.isImage !== isImage || item.isAudio !== isAudio) return false;
        
        // Untuk teks, bandingkan konten langsung
        if (!isImage && !isAudio) {
            return item.content.trim() === content.trim();
        }
        
        // Untuk gambar/audio, bandingkan data URL
        return item.content === content;
    });
}

// Modifikasi fungsi saveNotepadText untuk menambahkan pengecekan duplikat
function saveNotepadText() {
    const notepadTextarea = document.getElementById('notepad-textarea');
    const selectedWebhooks = getSelectedWebhooks();
    const status = document.getElementById("status");

    if (!notepadTextarea) return;

    const content = notepadTextarea.value.trim();
    if (!content) {
        status.textContent = "Cannot save empty content!";
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
        return;
    }

    if (selectedWebhooks.length === 0) {
        status.textContent = "Silakan pilih setidaknya satu webhook terlebih dahulu!";
        status.classList.add("text-red-500");
        return;
    }

    const paragraphs = content.split('\n').filter(p => p.trim() !== '');
    let duplicateFound = false;
    let duplicateWebhooks = new Set();

    // Periksa duplikat untuk setiap webhook
    selectedWebhooks.forEach(webhook => {
        paragraphs.forEach(paragraph => {
            if (checkDuplicateContent(webhook.url, paragraph)) {
                duplicateFound = true;
                duplicateWebhooks.add(webhook.name);
            }
        });
    });

    if (duplicateFound) {
        const webhookNames = Array.from(duplicateWebhooks).join(", ");
        const confirmAdd = confirm(`Peringatan: Beberapa konten sudah ada di webhook ${webhookNames}. Tetap tambahkan?`);
        if (!confirmAdd) {
            status.textContent = "Penambahan konten dibatalkan.";
            status.classList.remove("text-green-500");
            status.classList.add("text-red-500");
            return;
        }
    }

    // Lanjutkan dengan penambahan konten
    paragraphs.forEach(paragraph => {
        selectedWebhooks.forEach(webhook => {
            if (!noteDrafts[webhook.url]) {
                noteDrafts[webhook.url] = { name: webhook.name, items: [] };
            }
            noteDrafts[webhook.url].items.push({
                content: paragraph,
                isImage: false,
                isAudio: false
            });
        });
    });

    status.textContent = `Text ditambahkan ke draft untuk ${selectedWebhooks.length} webhook!`;
    status.classList.remove("text-red-500");
    status.classList.add("text-green-500");
    notepadTextarea.value = '';
    closeNotepad();
    updateDraftSections();
}

function deleteDraft(webhookUrl, index) {
    if (!noteDrafts[webhookUrl] || index < 0 || index >= noteDrafts[webhookUrl].items.length) {
        console.error('Invalid draft index or webhook:', webhookUrl, index);
        return;
    }
    noteDrafts[webhookUrl].items.splice(index, 1);
    if (noteDrafts[webhookUrl].items.length === 0) {
        delete noteDrafts[webhookUrl];
    }
    updateDraftSections();
}

function triggerMultiUpload() {
    const input = document.getElementById("multi-upload");
    if (!input) {
        console.error("Upload input element not found!");
        return;
    }
    input.click();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function dataURLtoBlob(dataURL) {
    const arr = dataURL.split(",");
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

function openNotepad() {
    const modal = document.getElementById('notepad-modal');
    if (!modal) {
        console.error('Notepad modal not found!');
        return;
    }
    const modalContent = modal.children[0];
    if (!modalContent) {
        console.error('Modal content not found!');
        return;
    }
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        modalContent.classList.add('scale-100', 'opacity-100');
        modalContent.classList.remove('scale-95', 'opacity-0');
    }, 10);
}

function closeNotepad() {
    const modal = document.getElementById('notepad-modal');
    const modalContent = modal.children[0];
    modal.classList.remove('opacity-100');
    modalContent.classList.remove('scale-100', 'opacity-100');
    modalContent.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Fungsi untuk memicu upload audio
function triggerAudioUpload() {
    const input = document.getElementById("audio-upload");
    if (!input) {
        console.error("Audio upload input element not found!");
        return;
    }
    input.click();
}

// Fungsi untuk menghasilkan MD5 hash
function generateMD5Hash() {
    const timestamp = new Date().getTime().toString();
    const random = Math.random().toString();
    const input = timestamp + random;
    
    // Implementasi MD5 hash
    function md5(input) {
        const md5lib = {
            hexcase: 0,
            b64pad: "",
            md5cycle: function(x, k) {
                let a = x[0], b = x[1], c = x[2], d = x[3];
                
                a = this.ff(a, b, c, d, k[0], 7, -680876936);
                d = this.ff(d, a, b, c, k[1], 12, -389564586);
                c = this.ff(c, d, a, b, k[2], 17, 606105819);
                b = this.ff(b, c, d, a, k[3], 22, -1044525330);
                a = this.ff(a, b, c, d, k[4], 7, -176418897);
                d = this.ff(d, a, b, c, k[5], 12, 1200080426);
                c = this.ff(c, d, a, b, k[6], 17, -1473231341);
                b = this.ff(b, c, d, a, k[7], 22, -45705983);
                a = this.ff(a, b, c, d, k[8], 7, 1770035416);
                d = this.ff(d, a, b, c, k[9], 12, -1958414417);
                c = this.ff(c, d, a, b, k[10], 17, -42063);
                b = this.ff(b, c, d, a, k[11], 22, -1990404162);
                a = this.ff(a, b, c, d, k[12], 7, 1804603682);
                d = this.ff(d, a, b, c, k[13], 12, -40341101);
                c = this.ff(c, d, a, b, k[14], 17, -1502002290);
                b = this.ff(b, c, d, a, k[15], 22, 1236535329);
                
                a = this.gg(a, b, c, d, k[1], 5, -165796510);
                d = this.gg(d, a, b, c, k[6], 9, -1069501632);
                c = this.gg(c, d, a, b, k[11], 14, 643717713);
                b = this.gg(b, c, d, a, k[0], 20, -373897302);
                a = this.gg(a, b, c, d, k[5], 5, -701558691);
                d = this.gg(d, a, b, c, k[10], 9, 38016083);
                c = this.gg(c, d, a, b, k[15], 14, -660478335);
                b = this.gg(b, c, d, a, k[4], 20, -405537848);
                a = this.gg(a, b, c, d, k[9], 5, 568446438);
                d = this.gg(d, a, b, c, k[14], 9, -1019803690);
                c = this.gg(c, d, a, b, k[3], 14, -187363961);
                b = this.gg(b, c, d, a, k[8], 20, 1163531501);
                a = this.gg(a, b, c, d, k[13], 5, -1444681467);
                d = this.gg(d, a, b, c, k[2], 9, -51403784);
                c = this.gg(c, d, a, b, k[7], 14, 1735328473);
                b = this.gg(b, c, d, a, k[12], 20, -1926607734);
                
                a = this.hh(a, b, c, d, k[5], 4, -378558);
                d = this.hh(d, a, b, c, k[8], 11, -2022574463);
                c = this.hh(c, d, a, b, k[11], 16, 1839030562);
                b = this.hh(b, c, d, a, k[14], 23, -35309556);
                a = this.hh(a, b, c, d, k[1], 4, -1530992060);
                d = this.hh(d, a, b, c, k[4], 11, 1272893353);
                c = this.hh(c, d, a, b, k[7], 16, -155497632);
                b = this.hh(b, c, d, a, k[10], 23, -1094730640);
                a = this.hh(a, b, c, d, k[13], 4, 681279174);
                d = this.hh(d, a, b, c, k[0], 11, -358537222);
                c = this.hh(c, d, a, b, k[3], 16, -722521979);
                b = this.hh(b, c, d, a, k[6], 23, 76029189);
                a = this.hh(a, b, c, d, k[9], 4, -640364487);
                d = this.hh(d, a, b, c, k[12], 11, -421815835);
                c = this.hh(c, d, a, b, k[15], 16, 530742520);
                b = this.hh(b, c, d, a, k[2], 23, -995338651);
                
                a = this.ii(a, b, c, d, k[0], 6, -198630844);
                d = this.ii(d, a, b, c, k[7], 10, 1126891415);
                c = this.ii(c, d, a, b, k[14], 15, -1416354905);
                b = this.ii(b, c, d, a, k[5], 21, -57434055);
                a = this.ii(a, b, c, d, k[12], 6, 1700485571);
                d = this.ii(d, a, b, c, k[3], 10, -1894986606);
                c = this.ii(c, d, a, b, k[10], 15, -1051523);
                b = this.ii(b, c, d, a, k[1], 21, -2054922799);
                a = this.ii(a, b, c, d, k[8], 6, 1873313359);
                d = this.ii(d, a, b, c, k[15], 10, -30611744);
                c = this.ii(c, d, a, b, k[6], 15, -1560198380);
                b = this.ii(b, c, d, a, k[13], 21, 1309151649);
                a = this.ii(a, b, c, d, k[4], 6, -145523070);
                d = this.ii(d, a, b, c, k[11], 10, -1120210379);
                c = this.ii(c, d, a, b, k[2], 15, 718787259);
                b = this.ii(b, c, d, a, k[9], 21, -343485551);
                
                x[0] = this.add32(a, x[0]);
                x[1] = this.add32(b, x[1]);
                x[2] = this.add32(c, x[2]);
                x[3] = this.add32(d, x[3]);
            },
            
            cmn: function(q, a, b, x, s, t) {
                a = this.add32(this.add32(a, q), this.add32(x, t));
                return this.add32((a << s) | (a >>> (32 - s)), b);
            },
            
            ff: function(a, b, c, d, x, s, t) {
                return this.cmn((b & c) | ((~b) & d), a, b, x, s, t);
            },
            
            gg: function(a, b, c, d, x, s, t) {
                return this.cmn((b & d) | (c & (~d)), a, b, x, s, t);
            },
            
            hh: function(a, b, c, d, x, s, t) {
                return this.cmn(b ^ c ^ d, a, b, x, s, t);
            },
            
            ii: function(a, b, c, d, x, s, t) {
                return this.cmn(c ^ (b | (~d)), a, b, x, s, t);
            },
            
            md51: function(s) {
                let n = s.length,
                state = [1732584193, -271733879, -1732584194, 271733878], i;
                for (i = 64; i <= s.length; i += 64) {
                    this.md5cycle(state, this.md5blk(s.substring(i - 64, i)));
                }
                s = s.substring(i - 64);
                let tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                for (i = 0; i < s.length; i++)
                    tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
                tail[i >> 2] |= 0x80 << ((i % 4) << 3);
                if (i > 55) {
                    this.md5cycle(state, tail);
                    for (i = 0; i < 16; i++) tail[i] = 0;
                }
                tail[14] = n * 8;
                this.md5cycle(state, tail);
                return state;
            },
            
            md5blk: function(s) {
                let md5blks = [], i;
                for (i = 0; i < 64; i += 4) {
                    md5blks[i >> 2] = s.charCodeAt(i) +
                        (s.charCodeAt(i + 1) << 8) +
                        (s.charCodeAt(i + 2) << 16) +
                        (s.charCodeAt(i + 3) << 24);
                }
                return md5blks;
            },
            
            hex_chr: '0123456789abcdef'.split(''),
            
            rhex: function(n) {
                let s = '', j = 0;
                for (; j < 4; j++)
                    s += this.hex_chr[(n >> (j * 8 + 4)) & 0x0F] +
                        this.hex_chr[(n >> (j * 8)) & 0x0F];
                return s;
            },
            
            hex: function(x) {
                for (let i = 0; i < x.length; i++)
                    x[i] = this.rhex(x[i]);
                return x.join('');
            },
            
            add32: function(a, b) {
                return (a + b) & 0xFFFFFFFF;
            }
        };
        
        return md5lib.hex(md5lib.md51(input));
    }
    
    return md5(input);
}

function openImagePreviewModal(imageUrl) {
    const modal = document.getElementById('image-preview-modal');
    const modalImage = document.getElementById('modal-image-preview');
    modalImage.src = imageUrl;
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
    }, 10);
}

function closeImagePreviewModal() {
    const modal = document.getElementById('image-preview-modal');
    modal.classList.remove('opacity-100');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300);
}

// Fungsi untuk validasi file
function validateFile(file, isAudio = false) {
    const errors = [];
    
    // Validasi ukuran
    if (file.size > FILE_CONFIG.MAX_FILE_SIZE) {
        errors.push(`File "${file.name}" terlalu besar (${(file.size / (1024 * 1024)).toFixed(2)}MB). Maksimal 8MB!`);
    }
    
    // Validasi tipe file
    const allowedTypes = isAudio ? FILE_CONFIG.ALLOWED_AUDIO_TYPES : FILE_CONFIG.ALLOWED_IMAGE_TYPES;
    if (!allowedTypes.includes(file.type)) {
        errors.push(`Tipe file "${file.name}" tidak didukung. Gunakan format: ${allowedTypes.join(', ')}`);
    }
    
    return errors;
}

// Fungsi untuk mengoptimasi gambar
async function optimizeImage(imageDataUrl, options = {}) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Set ukuran canvas sesuai gambar asli atau maksimum yang diinginkan
            let width = img.width;
            let height = img.height;
            
            // Jika gambar terlalu besar, resize dengan mempertahankan aspect ratio
            const maxWidth = options.maxWidth || 2048;
            const maxHeight = options.maxHeight || 2048;
            
            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height);
                width *= ratio;
                height *= ratio;
            }

            // Set ukuran canvas
            canvas.width = width;
            canvas.height = height;

            // Aplikasikan filter untuk meningkatkan kejernihan
            ctx.filter = 'contrast(1.1) saturate(1.1) sharpen(1)';
            
            // Gambar ke canvas dengan smoothing
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);

            // Konversi kembali ke format yang diinginkan dengan kualitas tinggi
            const optimizedDataUrl = canvas.toDataURL('image/jpeg', 0.92);
            resolve(optimizedDataUrl);
        };
        img.onerror = reject;
        img.src = imageDataUrl;
    });
}

// Modifikasi fungsi loadFileContent untuk menggunakan optimasi gambar
async function loadFileContent(input) {
    const files = Array.from(input.files);
    const status = document.getElementById("status");
    const selectedWebhooks = getSelectedWebhooks();

    try {
        if (!files.length) {
            throw new Error("No file selected.");
        }

        if (files.length > FILE_CONFIG.MAX_FILES_PER_UPLOAD) {
            throw new Error(`Maksimal ${FILE_CONFIG.MAX_FILES_PER_UPLOAD} file per upload!`);
        }

        if (selectedWebhooks.length === 0) {
            throw new Error("Silakan pilih setidaknya satu webhook terlebih dahulu!");
        }

        // Validasi semua file terlebih dahulu
        const errors = [];
        files.forEach(file => {
            const isAudio = file.type.startsWith('audio/');
            const fileErrors = validateFile(file, isAudio);
            errors.push(...fileErrors);
        });

        if (errors.length > 0) {
            throw new Error(errors.join('\n'));
        }

        files.sort((a, b) => a.lastModified - b.lastModified);
        fileQueue = files;
        updateFileList();

        // Proses file satu per satu
        for (const file of files) {
            await new Promise((resolve, reject) => {
                const reader = new FileReader();
                
                reader.onload = async function(e) {
                    try {
                        const fileType = file.name.split(".").pop().toLowerCase();
                        const isAudio = ['mp3', 'wav', 'ogg', 'm4a'].includes(fileType);
                        
                        let finalContent = e.target.result;
                        
                        // Jika file adalah gambar, lakukan optimasi
                        if (!isAudio && file.type.startsWith('image/')) {
                            try {
                                status.textContent = `Mengoptimasi gambar: ${file.name}...`;
                                finalContent = await optimizeImage(e.target.result, {
                                    maxWidth: 2048,
                                    maxHeight: 2048
                                });
                                status.textContent = `Optimasi selesai: ${file.name}`;
                            } catch (optimizeError) {
                                console.warn('Gagal mengoptimasi gambar:', optimizeError);
                                // Jika optimasi gagal, gunakan gambar original
                                status.textContent = `Menggunakan gambar original: ${file.name}`;
                            }
                        }

                        // Periksa duplikat
                        let duplicateFound = false;
                        let duplicateWebhooks = new Set();

                        selectedWebhooks.forEach(webhook => {
                            if (checkDuplicateContent(webhook.url, finalContent, !isAudio, isAudio)) {
                                duplicateFound = true;
                                duplicateWebhooks.add(webhook.name);
                            }
                        });

                        if (duplicateFound) {
                            const webhookNames = Array.from(duplicateWebhooks).join(", ");
                            const confirmAdd = confirm(`Peringatan: File "${file.name}" sudah ada di webhook ${webhookNames}. Tetap tambahkan?`);
                            if (!confirmAdd) {
                                status.textContent = "Penambahan file dibatalkan.";
                                status.classList.remove("text-green-500");
                                status.classList.add("text-red-500");
                                resolve();
                                return;
                            }
                        }

                        const randomFileName = `${generateMD5Hash()}.${fileType}`;
                        selectedWebhooks.forEach(webhook => {
                            if (!noteDrafts[webhook.url]) {
                                noteDrafts[webhook.url] = { name: webhook.name, items: [] };
                            }
                            noteDrafts[webhook.url].items.push({
                                content: finalContent,
                                fileName: randomFileName,
                                isImage: !isAudio,
                                isAudio: isAudio
                            });
                        });

                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                };

                reader.onerror = () => reject(new Error(`Error reading file: ${file.name}`));
                reader.readAsDataURL(file);
            });
        }

        updateDraftSections();
        status.textContent = `File berhasil ditambahkan ke draft untuk ${selectedWebhooks.length} webhook!`;
        status.classList.remove("text-red-500");
        status.classList.add("text-green-500");

    } catch (error) {
        console.error('Error:', error);
        status.textContent = error.message;
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
    } finally {
        fileQueue = [];
        updateFileList();
        input.value = "";
    }
}

// Fungsi untuk memproses antrian file
async function processFileQueue(selectedWebhooks, status) {
    if (!fileQueue.length) {
        status.textContent = "Tidak ada file untuk diproses.";
        status.classList.add("text-red-500");
        return;
    }

    status.textContent = "Memproses file...";
    status.classList.remove("text-red-500", "text-green-500");

    const readFile = (inputFile) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve({ result: e.target.result, file: inputFile });
            reader.onerror = (e) => reject(e);
            if (inputFile.type.startsWith("image/")) {
                reader.readAsDataURL(inputFile);
            } else {
                reader.readAsText(inputFile);
            }
        });
    };

    for (const currentFile of fileQueue) {
        try {
            const { result, file } = await readFile(currentFile);
            const fileType = file.name.split(".").pop().toLowerCase();

            console.log(`Memproses file: ${file.name}`);

            if (["png", "jpg", "jpeg", "gif"].includes(fileType)) {
                const blob = dataURLtoBlob(result);
                if (blob.size > 8 * 1024 * 1024) {
                    status.textContent = `Gambar "${file.name}" terlalu besar (${(blob.size / (1024 * 1024)).toFixed(2)}MB). Maksimal 8MB!`;
                    status.classList.add("text-red-500");
                    fileQueue = [];
                    updateFileList();
                    return;
                }
                const randomFileName = `${generateMD5Hash()}.${fileType}`;
                selectedWebhooks.forEach(webhook => {
                    if (!noteDrafts[webhook.url]) {
                        noteDrafts[webhook.url] = { name: webhook.name, items: [] };
                    }
                    noteDrafts[webhook.url].items.push({
                        content: result,
                        fileName: randomFileName,
                        isImage: true,
                        isAudio: false
                    });
                });
            } else if (fileType === "txt") {
                const lines = result.split(/\r?\n/);
                lines.forEach(line => {
                    if (line.trim() !== "") {
                        selectedWebhooks.forEach(webhook => {
                            if (!noteDrafts[webhook.url]) {
                                noteDrafts[webhook.url] = { name: webhook.name, items: [] };
                            }
                            noteDrafts[webhook.url].items.push({
                                content: line.trim(),
                                isImage: false,
                                isAudio: false
                            });
                        });
                    }
                });
            } else {
                status.textContent = "Unsupported file format.";
                status.classList.add("text-red-500");
                fileQueue = [];
                updateFileList();
                return;
            }

            updateDraftSections();
        } catch (error) {
            console.error("Error reading file:", error);
            status.textContent = "Terjadi kesalahan saat membaca file.";
            status.classList.add("text-red-500");
            fileQueue = [];
            updateFileList();
            return;
        }
    }

    status.textContent = `File ditambahkan ke draft untuk ${selectedWebhooks.length} webhook!`;
    status.classList.remove("text-red-500");
    status.classList.add("text-green-500");
    fileQueue = []; // Kosongkan antrian setelah selesai
    updateFileList();
}

// Fungsi untuk memperbarui daftar file di UI
function updateFileList() {
    const fileList = document.getElementById("file-list");
    fileList.innerHTML = "";
    
    fileQueue.forEach((file, index) => {
        const li = document.createElement("li");
        li.className = "flex items-center gap-3 p-2 bg-white rounded-lg shadow-sm mb-2 hover:bg-gray-50 transition-colors duration-200";
        
        // Buat preview gambar
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.className = "w-12 h-12 object-cover rounded";
        
        // Buat container untuk nama file
        const fileName = document.createElement("span");
        fileName.textContent = file.name;
        fileName.className = "flex-1 text-sm text-gray-700";
        
        // Tambahkan nomor urut
        const number = document.createElement("span");
        number.textContent = `${index + 1}.`;
        number.className = "text-sm font-medium text-gray-500";
        
        li.appendChild(number);
        li.appendChild(img);
        li.appendChild(fileName);
        
        // Tambahkan event listener untuk drag and drop
        li.draggable = true;
        li.dataset.index = index;
        
        li.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", index);
            li.classList.add("opacity-50");
        });
        
        li.addEventListener("dragend", () => {
            li.classList.remove("opacity-50");
        });
        
        li.addEventListener("dragover", (e) => {
            e.preventDefault();
            const draggingItem = document.querySelector(".opacity-50");
            if (draggingItem && draggingItem !== li) {
                const rect = li.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    li.parentNode.insertBefore(draggingItem, li);
                } else {
                    li.parentNode.insertBefore(draggingItem, li.nextSibling);
                }
                updateFileOrder();
            }
        });
        
        fileList.appendChild(li);
    });
}

// Fungsi untuk memperbarui urutan file setelah drag and drop
function updateFileOrder() {
    const fileList = document.getElementById("file-list");
    const items = Array.from(fileList.children);
    const newQueue = items.map(item => fileQueue[parseInt(item.dataset.index)]);
    fileQueue = newQueue;
    
    // Update nomor urut
    items.forEach((item, index) => {
        item.dataset.index = index;
        item.querySelector("span").textContent = `${index + 1}.`;
    });
}

// Modifikasi event listener untuk drop zone
document.addEventListener("DOMContentLoaded", () => {
    initializeWebhookSelector();
    updateDraftSections();

    const dropZone = document.getElementById("drop-zone");
    const status = document.getElementById("status");

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("bg-gray-100", "border-indigo-500");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("bg-gray-100", "border-indigo-500");
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("bg-gray-100", "border-indigo-500");

        const selectedWebhooks = getSelectedWebhooks();
        if (selectedWebhooks.length === 0) {
            status.textContent = "Silakan pilih setidaknya satu webhook terlebih dahulu!";
            status.classList.remove("text-green-500");
            status.classList.add("text-red-500");
            return;
        }

        const files = Array.from(e.dataTransfer.files);
        files.sort((a, b) => a.lastModified - b.lastModified);
        fileQueue = files;
        updateFileList();
        processFileQueue(selectedWebhooks, status);
    });

    dropZone.addEventListener("click", () => {
        triggerMultiUpload();
    });

    // Modifikasi tombol Send untuk memproses antrian terlebih dahulu
    const sendButton = document.querySelector('button[onclick="sendData()"]');
    if (sendButton) {
        sendButton.onclick = async () => {
            const selectedWebhooks = getSelectedWebhooks();
            if (fileQueue.length > 0) {
                await processFileQueue(selectedWebhooks, status);
            }
            sendData();
        };
    }
});

// Fungsi untuk memuat konten audio
function loadAudioContent(input) {
    const files = input.files;
    const status = document.getElementById("status");
    const selectedWebhooks = getSelectedWebhooks();

    if (!files.length) {
        status.textContent = "No audio file selected.";
        status.classList.add("text-red-500");
        return;
    }

    if (selectedWebhooks.length === 0) {
        status.textContent = "Silakan pilih setidaknya satu webhook terlebih dahulu!";
        status.classList.remove("text-green-500");
        status.classList.add("text-red-500");
        input.value = "";
        return;
    }

    status.textContent = "";
    status.classList.remove("text-red-500", "text-green-500");

    for (const file of files) {
        const reader = new FileReader();
        reader.onload = function (e) {
            const fileType = file.name.split(".").pop().toLowerCase();
            if (["mp3", "wav", "ogg", "m4a"].includes(fileType)) {
                const blob = dataURLtoBlob(e.target.result);

                if (blob.size > 8 * 1024 * 1024) {
                    status.textContent = `Audio "${file.name}" terlalu besar (${(blob.size / (1024 * 1024)).toFixed(2)}MB). Maksimal 8MB!`;
                    status.classList.add("text-red-500");
                    return;
                }

                // Periksa duplikat untuk setiap webhook
                let duplicateFound = false;
                let duplicateWebhooks = new Set();

                selectedWebhooks.forEach(webhook => {
                    if (checkDuplicateContent(webhook.url, e.target.result, false, true)) {
                        duplicateFound = true;
                        duplicateWebhooks.add(webhook.name);
                    }
                });

                if (duplicateFound) {
                    const webhookNames = Array.from(duplicateWebhooks).join(", ");
                    const confirmAdd = confirm(`Peringatan: Audio "${file.name}" sudah ada di webhook ${webhookNames}. Tetap tambahkan?`);
                    if (!confirmAdd) {
                        status.textContent = "Penambahan audio dibatalkan.";
                        status.classList.remove("text-green-500");
                        status.classList.add("text-red-500");
                        return;
                    }
                }

                const randomFileName = `${generateMD5Hash()}.${fileType}`;
                selectedWebhooks.forEach(webhook => {
                    if (!noteDrafts[webhook.url]) {
                        noteDrafts[webhook.url] = { name: webhook.name, items: [] };
                    }
                    noteDrafts[webhook.url].items.push({
                        content: e.target.result,
                        fileName: randomFileName,
                        isImage: false,
                        isAudio: true
                    });
                });
                updateDraftSections();
                status.textContent = `Audio ditambahkan ke draft untuk ${selectedWebhooks.length} webhook!`;
                status.classList.remove("text-red-500");
                status.classList.add("text-green-500");
            } else {
                status.textContent = "Format audio tidak didukung. Gunakan MP3, WAV, OGG, atau M4A.";
                status.classList.add("text-red-500");
            }
        };
        reader.readAsDataURL(file);
    }
    input.value = "";
}

// Fungsi untuk menghitung statistik
function calculateStats() {
    const stats = {
        totalDrafts: 0,
        activeWebhooks: 0,
        totalFileSize: 0,
        textCount: 0,
        imageCount: 0,
        audioCount: 0
    };

    // Hitung webhook aktif dan total draft
    Object.entries(noteDrafts).forEach(([webhookUrl, data]) => {
        if (data.items.length > 0) {
            stats.activeWebhooks++;
            stats.totalDrafts += data.items.length;

            // Hitung berdasarkan tipe
            data.items.forEach(item => {
                if (item.isImage) {
                    stats.imageCount++;
                    const blob = dataURLtoBlob(item.content);
                    stats.totalFileSize += blob.size;
                } else if (item.isAudio) {
                    stats.audioCount++;
                    const blob = dataURLtoBlob(item.content);
                    stats.totalFileSize += blob.size;
                } else {
                    stats.textCount++;
                    stats.totalFileSize += new Blob([item.content]).size;
                }
            });
        }
    });

    return stats;
}

// Fungsi untuk memformat ukuran file
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Fungsi untuk menampilkan modal statistik
function showStatsModal() {
    const stats = calculateStats();
    const modal = document.getElementById('stats-modal');
    const statsContent = document.getElementById('stats-content');
    
    // Update konten statistik
    statsContent.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <div class="flex items-center gap-3">
                    <i data-lucide="file-text" class="w-8 h-8 text-blue-500"></i>
                    <div>
                        <h3 class="text-sm font-medium text-gray-500">Total Draft</h3>
                        <p class="text-2xl font-semibold text-gray-900">${stats.totalDrafts}</p>
                    </div>
                </div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <div class="flex items-center gap-3">
                    <i data-lucide="webhook" class="w-8 h-8 text-purple-500"></i>
                    <div>
                        <h3 class="text-sm font-medium text-gray-500">Webhook Aktif</h3>
                        <p class="text-2xl font-semibold text-gray-900">${stats.activeWebhooks}</p>
                    </div>
                </div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <div class="flex items-center gap-3">
                    <i data-lucide="hard-drive" class="w-8 h-8 text-green-500"></i>
                    <div>
                        <h3 class="text-sm font-medium text-gray-500">Total Ukuran</h3>
                        <p class="text-2xl font-semibold text-gray-900">${formatFileSize(stats.totalFileSize)}</p>
                    </div>
                </div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <i data-lucide="file-text" class="w-5 h-5 text-gray-400"></i>
                        <span class="text-sm text-gray-600">Teks</span>
                    </div>
                    <span class="text-lg font-semibold text-gray-900">${stats.textCount}</span>
                </div>
                <div class="flex items-center justify-between mt-2">
                    <div class="flex items-center gap-2">
                        <i data-lucide="image" class="w-5 h-5 text-gray-400"></i>
                        <span class="text-sm text-gray-600">Gambar</span>
                    </div>
                    <span class="text-lg font-semibold text-gray-900">${stats.imageCount}</span>
                </div>
                <div class="flex items-center justify-between mt-2">
                    <div class="flex items-center gap-2">
                        <i data-lucide="mic" class="w-5 h-5 text-gray-400"></i>
                        <span class="text-sm text-gray-600">Audio</span>
                    </div>
                    <span class="text-lg font-semibold text-gray-900">${stats.audioCount}</span>
                </div>
            </div>
        </div>
    `;

    // Tampilkan modal
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        const modalContent = modal.children[0];
        modalContent.classList.add('scale-100', 'opacity-100');
        modalContent.classList.remove('scale-95', 'opacity-0');
        // Reinisialisasi ikon Lucide
        lucide.createIcons();
    }, 10);
}

// Fungsi untuk menutup modal statistik
function closeStatsModal() {
    const modal = document.getElementById('stats-modal');
    const modalContent = modal.children[0];
    modal.classList.remove('opacity-100');
    modalContent.classList.remove('scale-100', 'opacity-100');
    modalContent.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 200);
}

// Tambahkan struktur data untuk history
let messageHistory = [];

// Fungsi untuk menyimpan history ke database
async function saveHistoryToDatabase(sessionHistory) {
    try {
        const response = await fetch('/api/history', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(sessionHistory)
        });
        
        if (!response.ok) {
            throw new Error('Failed to save history');
        }
        
        // Tetap simpan di localStorage sebagai backup
        try {
            const existingHistory = JSON.parse(localStorage.getItem('messageHistory') || '[]');
            existingHistory.push(sessionHistory);
            if (existingHistory.length > 100) {
                existingHistory = existingHistory.slice(-100);
            }
            localStorage.setItem('messageHistory', JSON.stringify(existingHistory));
        } catch (e) {
            console.warn('Failed to save to localStorage:', e);
        }
        
    } catch (error) {
        console.error('Error saving history:', error);
        // Fallback ke localStorage jika database tidak tersedia
        try {
            const existingHistory = JSON.parse(localStorage.getItem('messageHistory') || '[]');
            existingHistory.push(sessionHistory);
            if (existingHistory.length > 100) {
                existingHistory = existingHistory.slice(-100);
            }
            localStorage.setItem('messageHistory', JSON.stringify(existingHistory));
        } catch (e) {
            console.error('Failed to save history:', e);
        }
    }
}

// Fungsi untuk mengambil history dari database
async function getHistoryFromDatabase() {
    try {
        const response = await fetch('/api/history');
        if (!response.ok) {
            throw new Error('Failed to fetch history');
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching history:', error);
        // Fallback ke localStorage jika database tidak tersedia
        try {
            return JSON.parse(localStorage.getItem('messageHistory') || '[]');
        } catch (e) {
            console.error('Failed to get history:', e);
            return [];
        }
    }
}

// Fungsi untuk menghapus history dari database
async function clearHistoryFromDatabase() {
    try {
        const response = await fetch('/api/history', {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error('Failed to clear history');
        }
        
        // Bersihkan juga localStorage
        localStorage.removeItem('messageHistory');
    } catch (error) {
        console.error('Error clearing history:', error);
    }
}

// Modifikasi fungsi showHistoryModal untuk menggunakan database
async function showHistoryModal() {
    const modal = document.getElementById('history-modal');
    const historyContent = document.getElementById('history-content');
    
    // Tampilkan loading state
    historyContent.innerHTML = `
        <div class="flex items-center justify-center p-8">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span class="ml-2">Loading history...</span>
        </div>
    `;
    
    try {
        // Ambil history dari database
        messageHistory = await getHistoryFromDatabase();
        
        // Generate HTML untuk history
        let historyHTML = `
            <div class="space-y-4">
                ${messageHistory.reverse().map((session, index) => `
                    <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                        <div class="flex items-center justify-between mb-3">
                            <div class="flex items-center gap-2">
                                <i data-lucide="clock" class="w-5 h-5 text-gray-400"></i>
                                <span class="text-sm font-medium text-gray-600">${session.timestamp}</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-medium text-gray-600">Success: ${session.stats.success}/${session.stats.total}</span>
                                ${session.stats.failed > 0 ? 
                                    `<span class="text-sm font-medium text-red-600">Failed: ${session.stats.failed}</span>` : 
                                    ''
                                }
                            </div>
                        </div>
                        <div class="space-y-2">
                            ${session.items.map(item => `
                                <div class="flex items-center justify-between py-2 border-t border-gray-100">
                                    <div class="flex items-center gap-2">
                                        <i data-lucide="${item.type === 'image' ? 'image' : item.type === 'audio' ? 'mic' : 'file-text'}" 
                                           class="w-4 h-4 ${item.status === 'success' ? 'text-green-500' : 'text-red-500'}"></i>
                                        <span class="text-sm text-gray-600">${
                                            item.type === 'text' ? 
                                            (item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content) : 
                                            item.content
                                        }</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs text-gray-500">${item.webhook}</span>
                                        <span class="px-2 py-1 text-xs rounded-full ${
                                            item.status === 'success' ? 
                                            'bg-green-50 text-green-600' : 
                                            'bg-red-50 text-red-600'
                                        }">${item.status}</span>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        historyContent.innerHTML = historyHTML;
    } catch (error) {
        historyContent.innerHTML = `
            <div class="text-center p-8">
                <div class="text-red-500 mb-2">Failed to load history</div>
                <button onclick="showHistoryModal()" class="text-blue-500 hover:underline">Try again</button>
            </div>
        `;
    }

    // Tampilkan modal
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        const modalContent = modal.children[0];
        modalContent.classList.add('scale-100', 'opacity-100');
        modalContent.classList.remove('scale-95', 'opacity-0');
        // Reinisialisasi ikon Lucide
        lucide.createIcons();
    }, 10);
}

// Modifikasi fungsi clearHistory untuk menggunakan database
async function clearHistory() {
    if (confirm('Apakah Anda yakin ingin menghapus semua riwayat pengiriman?')) {
        try {
            await clearHistoryFromDatabase();
            messageHistory = [];
            closeHistoryModal();
        } catch (error) {
            alert('Gagal menghapus history. Silakan coba lagi.');
        }
    }
}