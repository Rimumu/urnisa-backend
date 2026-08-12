// --- MOD INTEGRATION ENDPOINTS ---

// Fetch lightweight card by sync code
app.get('/api/mod/bingo/:syncCode', async (req, res) => {
    try {
        const { syncCode } = req.params;
        const card = await BingoCard.findOne({ syncCode: syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: "Card not found. Invalid Sync Code." });

        // Map gridData to a lightweight array for the mod
        const cells = card.gridData.map((cell, index) => ({
            index,
            id: cell.id,
            name: cell.name,
            marked: card.marked[index]
        }));

        res.json({
            discordId: card.discordId,
            name: card.name,
            cardId: card.cardId,
            cells
        });
    } catch (e) {
        console.error("Mod Bingo Fetch Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});

// Mark a cell as caught
app.post('/api/mod/bingo/:syncCode/mark', async (req, res) => {
    try {
        const { syncCode } = req.params;
        const { index } = req.body; // Provide the index to mark

        const card = await BingoCard.findOne({ syncCode: syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: "Card not found." });

        if (index < 0 || index > 24) return res.status(400).json({ error: "Invalid index." });

        // Mark it
        const newMarked = [...card.marked];
        newMarked[index] = true;

        await BingoCard.findOneAndUpdate(
            { syncCode: syncCode.toUpperCase() },
            { marked: newMarked, updatedAt: new Date() }
        );

        res.json({ success: true, message: `Cell ${index} marked.` });
    } catch (e) {
        console.error("Mod Bingo Mark Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});

// Unmark a cell
app.post('/api/mod/bingo/:syncCode/unmark', async (req, res) => {
    try {
        const { syncCode } = req.params;
        const { index } = req.body;

        const card = await BingoCard.findOne({ syncCode: syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: "Card not found." });

        if (index < 0 || index > 24) return res.status(400).json({ error: "Invalid index." });

        const newMarked = [...card.marked];
        newMarked[index] = false;

        await BingoCard.findOneAndUpdate(
            { syncCode: syncCode.toUpperCase() },
            { marked: newMarked, updatedAt: new Date() }
        );

        res.json({ success: true, message: `Cell ${index} unmarked.` });
    } catch (e) {
        console.error("Mod Bingo Unmark Error:", e);
        res.status(500).json({ error: "Server Error" });
    }
});
